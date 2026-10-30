// The "Sign in with …" button on EmDash's login, setup and invite pages, for
// the OpenID Connect sign-in (oidc.ts). An invite page passes its invite,
// and a login page's ?redirect= is where to go afterwards.

const LABEL: string = import.meta.env.NEWSLEDITOR_OIDC_LABEL || "your organisation";

export function LoginButton({ inviteToken }: { inviteToken?: string }) {
  const params = new URLSearchParams();
  if (inviteToken) params.set("invite", inviteToken);
  const next = typeof location === "undefined" ? null : new URLSearchParams(location.search).get("redirect");
  if (next) params.set("next", next);
  const query = params.toString();
  return (
    <a
      href={`/_emdash/api/auth/oidc/login${query ? `?${query}` : ""}`}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: "100%",
        boxSizing: "border-box",
        padding: "10px 16px",
        borderRadius: 8,
        border: "1px solid currentColor",
        font: "inherit",
        fontWeight: 600,
        color: "inherit",
        textDecoration: "none",
      }}
    >
      Sign in with {LABEL}
    </a>
  );
}
