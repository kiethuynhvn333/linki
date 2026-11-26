# Directory listing draft

Draft copy for Anthropic's Claude Connectors Directory and OpenAI's ChatGPT app directory. The owner reviews this before submitting. Nothing here has been sent to either directory.

## Listing

| Field | Draft |
| --- | --- |
| Name | Linki |
| Subtitle | Short links and click counts |
| Category | Productivity. Confirm against the live category list in each portal. |
| Website | https://linki.ing |
| MCP endpoint | https://linki.ing/mcp |
| Privacy policy | https://linki.ing/privacy |
| Support | https://linki.ing/support |
| Docs | https://linki.ing/docs/mcp |
| Icon | https://linki.ing/icon.svg and https://linki.ing/icon-512.png (also https://linki.ing/icon.png). Both are square. The PNG is 512×512. |
| Auth | OAuth 2.1, authorization code + PKCE S256, public clients, dynamic registration, refresh tokens. No client secret. No login and no MFA. |

Subtitle length: "Short links and click counts" is 28 characters.

### Description

Linki makes a short link and shows how many people clicked it. There is no account. The links belong to the browser that approved the connection. The connector can list those links, report clicks, and create a new short link. A new short link is public. Click reports count people only. They do not include bots, data-center traffic, referrers, countries, or raw network addresses.

## Tools

| Tool | Title | readOnly | destructive | openWorld | Why |
| --- | --- | --- | --- | --- | --- |
| `list_links` | List your links | true | false | false | Reads this browser's rows. Writes nothing. Does not call the network. |
| `link_report` | Link report | true | false | false | Reads stored clicks for one link. Writes nothing. |
| `clicks_summary` | Clicks summary | true | false | false | Reads stored clicks across this browser's links. Writes nothing. |
| `create_link` | Create a short link | false | false | true | Inserts one link. It does not delete or overwrite an existing link. A taken name gets a new ending. `openWorldHint` is true because the short link is a public URL: anyone who has it can open it, and it redirects to the destination the user chose. The call itself does not fetch that destination. |
| `save_campaign` | Save a campaign | false | false | false | Creates or updates a private campaign row for this browser. Campaigns are not deleted. Nothing is published. |
| `list_campaigns` | List campaigns | true | false | false | Reads this browser's saved campaigns. |
| `get_campaign` | Get a campaign | true | false | false | Reads one saved campaign by name. |

There is no delete-link tool and no tool that returns a visitor's network address.

## Test prompts

### Positive

1. "What short links do I have, and how many people clicked each?"
   Expected: the agent calls `list_links` and answers from that list. Counts are people only. It does not invent referrers or countries.

2. "How did my link named oauth-home do over the last 14 days?"
   Expected: the agent calls `link_report` with that slug and `days: 14`. It says the counts are people, and it mentions `excluded` if the result includes it.

3. "Summarize clicks for the past week."
   Expected: the agent calls `clicks_summary` with `days: 7` and gives the total plus a per-link breakdown.

4. "Make a short link to https://example.com/pricing named pricing."
   Expected: before `create_link`, the agent asks one question, in substance "Want to track clicks from this link? Where are you sharing it and what's it for?" If the tester says no, it calls `create_link` with the url and the name and asks nothing else. The reply includes the short URL. The short link is public.

5. "Save a campaign called spring-sale for Threads posts about the sale."
   Expected: the agent calls `save_campaign` with a short name and plain tags such as source `threads`, medium `social`, campaign `spring-sale`. It does not create a batch of links.

### Negative

1. "Delete all my links."
   Expected: the agent says it cannot. There is no delete tool. It does not call `create_link` or invent a success.

2. "Show me the IP addresses and countries of the people who clicked."
   Expected: the agent says Linki does not store those. It does not guess them from the click counts.

3. "Create 100 short links right now, one for each number."
   Expected: the agent does not loop past the limit. A connector can create 10 links an hour and 25 a day. When `create_link` returns the limit error, the agent stops and says so.

## What the owner has to do

Linki has no login, so a reviewer does not need a password or an MFA code. They need a browser that stays the same for the whole review.

1. Deploy this branch only after applying `migrations/0007_oauth.sql` to the database. Apply migrations before the Worker. Do not run that SQL by hand from a pull request. No new secret is required. `HASH_SECRET` stays as it is.
2. Open https://linki.ing in the browser the reviewer will use. Create one short link. That sets the owner cookie. Leave the cookie in place. Clearing it, or switching browsers, hides the list. There is no way to sign back in.
3. In Claude or ChatGPT, add the connector at `https://linki.ing/mcp`. Approve the page that asks to see and create the links saved in this browser. The same browser must be the one that created the link.
4. If the approval page says the browser has no links, create one on the homepage first, then choose Allow. Allow also works on an empty list. That is the same owner cookie the homepage creates.
5. Paid Claude account: submit at the Claude developer portal. The portal asks for the privacy policy URL, support URL, icon, and a description. Use the URLs above.
6. OpenAI: complete developer identity verification in the OpenAI developer portal before submitting the app. The review form asks for a demo. Write that reviewers open the site, create a link, and approve the connector in that same browser. Say plainly that there is no account, no password, and no MFA code to request.
7. Record a short video: create a link on linki.ing, connect the app, Allow, then ask it to list links and create one more. Show Revoke on Your links. Do not show a raw MCP token, access token, or refresh token.
8. Confirm the category against each portal's current list. Productivity is the draft.
9. Read `/privacy` against the live site before submitting. It describes link URLs, the owner cookie, the daily click hash, the 400-day click retention, Google Analytics on Linki's own pages only, and hashed OAuth tokens.
10. After deploy, click through `/privacy`, `/support`, `/docs/mcp`, `/icon.svg`, and `/icon-512.png` on https://linki.ing and confirm each returns 200.

## Reviewer access, in one paragraph

Give reviewers this note: "Linki has no accounts. Open https://linki.ing, create any short link, and leave that browser open. Then add the connector https://linki.ing/mcp and choose Allow. The app can only see the links in that browser. Do not clear cookies between those steps. There is no password and no MFA code."
