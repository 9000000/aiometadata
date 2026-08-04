# Sign-in with an identity provider

Signing in with an OpenID Connect provider lets people reach their configurations with an account they already have, instead of a UUID and a password. It is entirely optional: with it switched off, nothing about the addon changes.

Once someone has saved a configuration to their account, opening it asks for nothing. The list of their saved configurations is on the sign-in dialog and in the dashboard.

## Before you start

- **Redis is required.** Sessions live there, not in the database.
- **The addon needs a stable public hostname over HTTPS.** The redirect URI is derived from the request, so an instance reached under two names will hand the provider two different URIs, and the provider will reject whichever it does not know.

## Register the addon with your provider

Create a confidential client with:

| | |
|---|---|
| Redirect URI | `https://<your-host>/api/auth/oidc/callback` |
| Grant type | authorization code |
| PKCE | S256 (always sent) |
| Scopes | `openid profile email groups` |

`groups` is requested because the permission mapping reads it. A provider that does not know that scope generally ignores it; one that rejects unknown scopes needs it defined, or `OIDC_GROUPS_CLAIM` pointed at a claim it does issue.

The exact redirect URI your instance will send is shown at `GET /api/auth/status`, which is the quickest way to settle a mismatch.

## Settings

All of these are in the dashboard under **Server**, or as environment variables. Only the client secret is environment-only.

| Setting | Default | What it does |
|---|---|---|
| `OIDC_ENABLED` | `false` | Turns sign-in on. Does nothing until an issuer, client id and secret are set. |
| `OIDC_ISSUER` | — | Your provider's root URL. Discovery is read from `/.well-known/openid-configuration` beneath it. |
| `OIDC_CLIENT_ID` | — | Client id the provider issued. |
| `OIDC_CLIENT_SECRET` | — | Client secret. Environment only. |
| `OIDC_GROUPS_CLAIM` | `groups` | Which claim the permission mapping reads. |
| `OIDC_USERNAME_CLAIM` | — | Which claim names the account. Empty tries `preferred_username`, then `name`, then the email address. |
| `OIDC_GROUP_PERMISSIONS` | — | Maps groups to permissions. See below. |
| `OIDC_DEFAULT_PERMISSIONS` | — | What an identity matching nothing gets. Empty refuses the sign-in. |
| `OIDC_ALLOW_INSECURE_ISSUER` | `false` | Permits an `http` issuer. The secret and tokens then travel in the clear. |
| `OIDC_RATE_LIMIT_PER_WINDOW` | `20` | Sign-in attempts allowed per address per window. |
| `OIDC_RATE_LIMIT_WINDOW` | `300` | Length of that window, in seconds. |
| `SESSION_TTL_SECONDS` | `86400` | How long a sign-in lasts. |

## Permissions

Two permissions exist:

- **`admin`** — reaches the dashboard.
- **`createConfig`** — may create and save configurations.

`OIDC_GROUP_PERMISSIONS` maps groups to them, as `group=permission|permission`, comma separated:

```env
OIDC_GROUP_PERMISSIONS=admins=admin|createConfig,users=createConfig
```

An identity matching no group falls to `OIDC_DEFAULT_PERMISSIONS`. **Leave that empty unless you mean it** — empty refuses the sign-in, which is what keeps an unmatched identity out. An entry the addon cannot parse also refuses the sign-in rather than guessing.

Setting `OIDC_DEFAULT_PERMISSIONS=admin` makes every identity your provider will authenticate an administrator here. That is reasonable when the provider itself decides who may reach the instance, as with a private Authelia or Keycloak. It is not reasonable with a provider that will authenticate anybody, such as Google.

Nothing requires the claim to be group membership. Point `OIDC_GROUPS_CLAIM` at `email` and the mapping becomes an allowlist of addresses, which is how providers without groups are handled:

```env
OIDC_GROUPS_CLAIM=email
OIDC_GROUP_PERMISSIONS=you@example.com=admin|createConfig
```

Group changes at the provider take effect at the next sign-in, not immediately, because permissions are read into the session. `SESSION_TTL_SECONDS` bounds that delay.

## Worked example: Authelia

In `configuration.yml`:

```yaml
identity_providers:
  oidc:
    clients:
      - client_id: aiometadata
        client_name: AIOMetadata
        client_secret: '$pbkdf2-sha512$...'   # hashed, from `authelia crypto hash generate pbkdf2`
        public: false
        authorization_policy: two_factor
        redirect_uris:
          - https://aiometadata.example.com/api/auth/oidc/callback
        scopes: [openid, profile, email, groups]
        grant_types: [authorization_code]
        response_types: [code]
        token_endpoint_auth_method: client_secret_basic
```

and on the addon:

```env
OIDC_ENABLED=true
OIDC_ISSUER=https://auth.example.com
OIDC_CLIENT_ID=aiometadata
OIDC_CLIENT_SECRET=<the plaintext secret, not the hash>
OIDC_GROUP_PERMISSIONS=admins=admin|createConfig,users=createConfig
```

Two things worth knowing about Authelia specifically:

- The secret in `configuration.yml` is a **hash**; the addon needs the **plaintext**.
- If your file ends with a `...` document-end marker, anything appended after it is outside the document and silently ignored — and `authelia validate-config` still reports success. Put the client block above that marker.

## What a user sees

Signing in is a button on the configure page and on the dashboard login. It does not, by itself, open anything: an account and a configuration are separate things until they are linked.

Linking happens through **Save this to your account**, which asks for the configuration's password once. That is the only time it is asked. From then on, opening that configuration — by picking it from the list, or by visiting its URL while signed in — needs nothing.

A password prompt reappearing on a configuration you thought was linked almost always means it was never saved to the account, only opened with its password.

## Troubleshooting

**"Sign-in failed" straight after the provider redirects back.** Usually the client authentication method. The addon reads `token_endpoint_auth_methods_supported` from discovery and uses `client_secret_post` only when the provider advertises it and not `client_secret_basic`; otherwise it sends HTTP Basic. A client registered as the other one fails at the token exchange. Align the registration with what discovery advertises.

**Redirected back but still asked for a password.** The configuration is not linked to the account yet. Use *Save this to your account* once.

**A group change had no effect.** Permissions are read at sign-in. Sign out and back in, or wait out `SESSION_TTL_SECONDS`.

**Sign-in refused for someone who should be allowed.** They matched no entry in `OIDC_GROUP_PERMISSIONS` and `OIDC_DEFAULT_PERMISSIONS` is empty. Confirm what the provider actually issues in the claim named by `OIDC_GROUPS_CLAIM`; a provider that omits the `groups` scope sends no groups at all.
