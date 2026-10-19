# The netgame relay

`relay.js` is a small Cloudflare Worker that helps players find each other for co-op and
deathmatch. The game itself stays peer to peer: only the handshake and, when a direct path
isn't possible, the TURN relay go through Cloudflare.

- **Room codes.** The host's invite waits under a six-letter code (no I, O, 0 or 1) for ten
  minutes; the guest types the code, and their reply goes back the same way. Nobody pastes the
  long codes. One guest per room; the host makes a new room for each guest.
- **TURN.** `/ice` hands out Cloudflare's STUN server and TURN servers with credentials minted
  for that call (four hours), so players behind strict NATs or firewalls can still connect.
  Without a TURN key it hands out STUN alone.

Without a relay the page works as before: codes swapped by hand, STUN only.

## Deploying

You need a Cloudflare account (the free plan will do: Durable Objects on SQLite storage and
TURN's free allowance are part of it).

1. **A TURN key.** In the Cloudflare dashboard, *Realtime → TURN Server → Create*. Note the
   **Turn Token ID** and the **API Token**.
2. **Deploy the Worker**, from this directory:

   ```bash
   cd worker
   npx wrangler login
   npx wrangler secret put TURN_KEY_ID          # the Turn Token ID
   npx wrangler secret put TURN_KEY_API_TOKEN   # the API Token
   npx wrangler deploy
   ```

   It prints the Worker's URL, something like `https://firebird-doom-relay.<you>.workers.dev`.
3. **Who may call it.** `ALLOWED_ORIGINS` in `wrangler.toml` is the game's site
   (`https://mariuz.github.io`). Add others, comma-separated, if the game is served from
   elsewhere too (a local dev server, say `http://localhost:8080`).
4. **Tell the site.** In the GitHub repository, *Settings → Secrets and variables → Actions →
   Variables*, add `RELAY_URL` with the Worker's URL. The next deploy writes it into
   `relay.json`, and the page's **Relay** field starts out with it. Players can also point the
   page at another relay with `?relay=URL` or the field itself.

## Trying it without deploying

```bash
npm run relay        # the Worker's own code under Node, on http://localhost:8787 (any origin)
```

Then open the page with `?relay=http://localhost:8787`. `npm run test:relay` checks the Worker
(rooms, expiry, limits, origins, the TURN request, with Cloudflare's API faked), and
`npm run test:coop` ends with two pages joining through it by a room code.

## Limits worth knowing

- The origin check stops other web pages from using the relay, but not a script that sends a
  forged `Origin` header. The worst it can do is mint TURN credentials against your allowance
  (they last four hours); revoke the key in the dashboard if that ever happens.
- Codes over 16 KB are refused, and rooms expire after ten minutes whether used or not.
