import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

// After an update, Claude keeps the newsletter's tools.
//
// EmDash hides a plugin's tools from Claude once their definitions differ
// from what an Admin approved (the name, description and shape of each, kept
// in _plugin_state.mcp_tools_consent), so an update that changes any of them
// would quietly take them away until an Admin clicked Connect Claude again.
// The installers run by that Admin leave a note in the data folder when they
// install or update (installer/mac/install.sh, installer/windows/install.ps1);
// on the first request after that, the tools as they now are get approved,
// only if an Admin had approved them before. Then the note goes.

const PLUGIN = "newsletter";
const NOTE = "approve-claude-tools";

/** What this needs of EmDash's runtime (locals.emdash). */
interface Runtime {
  db: {
    selectFrom(table: "_plugin_state"): {
      select(cols: string[]): {
        where(col: string, op: "=", value: string): { executeTakeFirst(): Promise<Record<string, unknown> | undefined> };
      };
    };
    updateTable(table: "_plugin_state"): {
      set(values: Record<string, unknown>): {
        where(col: string, op: "=", value: string): { execute(): Promise<unknown> };
      };
    };
  };
  getPluginMcpTools(pluginId?: string): Promise<unknown[]>;
  serializePluginMcpConsent(tools: unknown[], pluginId: string): string;
}

let checked: Promise<void> | null = null;

/**
 * Once per process: approve the tools again if an installer asked for it.
 * Anonymous page views get a cut-down runtime without the database or the
 * tools; the check waits for a request with the full one (someone signed in,
 * or Claude itself, which is checked before its tools are listed).
 */
export function approveToolsAfterUpdate(emdash: unknown): Promise<void> {
  const runtime = emdash as Partial<Runtime> | undefined;
  if (!runtime?.db || !runtime.getPluginMcpTools || !runtime.serializePluginMcpConsent) return Promise.resolve();
  checked ??= approve(runtime as Runtime).catch((err) => {
    console.error("[claude-tools] couldn't approve the newsletter's tools after the update:", err);
  });
  return checked;
}

async function approve(emdash: Runtime): Promise<void> {
  const note = join(process.env.DATA_DIR ?? join(process.cwd(), "data"), NOTE);
  if (!existsSync(note)) return;
  const state = await emdash.db
    .selectFrom("_plugin_state")
    .select(["mcp_tools_enabled", "mcp_tools_consent"])
    .where("plugin_id", "=", PLUGIN)
    .executeTakeFirst();
  // Only tools an Admin turned on before: an update never turns them on.
  if (state && Number(state.mcp_tools_enabled) === 1) {
    const consent = emdash.serializePluginMcpConsent(await emdash.getPluginMcpTools(PLUGIN), PLUGIN);
    if (state.mcp_tools_consent !== consent) {
      await emdash.db.updateTable("_plugin_state").set({ mcp_tools_consent: consent }).where("plugin_id", "=", PLUGIN).execute();
      console.log("[claude-tools] approved the newsletter's tools as updated");
    }
  }
  rmSync(note, { force: true });
}
