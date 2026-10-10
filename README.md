# Roblox Wheel Spin: Cloudflare Pages + D1

A text-only wheel spin system. Players enter two usernames and a fan club screenshot. The screenshot is read **on the player's own device** with Tesseract.js and never uploaded. Only the extracted text goes to the server, which checks it against values stored in your D1 database.

Everything runs on Cloudflare Pages, Pages Functions and D1. No other database or backend.

## What is in this folder

```
functions/api/submit.js       entry validation worker      -> POST /api/submit
functions/api/list.js         data hub (public + admin)    -> /api/list
functions/api/public-list.js  re-exports list.js           -> /api/public-list
public/index.html             player entry portal
public/wheel.html             stream display (put this in OBS)
public/admin.html             host control panel
public/js/portal-engine.js    form, scanner, submit
public/js/wheel-engine.js     sync, physics, sound
public/js/admin-engine.js     dashboard controller
public/images/filler1.png     placeholder: Roblox name guide  (replace)
public/images/filler2.png     placeholder: TikTok handle guide (replace)
public/audio/rolling.mp3      placeholder drumroll             (replace)
public/audio/victory.mp3      placeholder victory theme        (replace)
schema.sql                    paste into the D1 console
README.md                     this file
```

Only `public/` is served to visitors. `schema.sql` holds your verification values, so keep it **outside** `public/`.

> **Why 3 function files instead of 2?** Pages maps one route per file. The wheel display polls `/api/public-list` and the dashboard uses `/api/list`, so `public-list.js` is a one-line re-export of the same handler.

---

## Setup from a phone browser

You need a free Cloudflare account and a free GitHub account.

> **Important:** Cloudflare's drag-and-drop upload does **not** support the `functions` folder. Use the GitHub route below. It works fine on mobile.

### Step 1. Create the D1 database

1. Open the Cloudflare dashboard in your mobile browser and sign in. If the layout is cramped, tap your browser menu and choose **Desktop site**.
2. Open the left menu, then **Storage & Databases** > **D1 SQL Database**. On older dashboards it is under **Workers & Pages** > **D1**.
3. Tap **Create Database**.
4. Name it `wheel-spin-db` (any name works) and tap **Create**.

### Step 2. Run the schema

1. Open your new database and tap the **Console** tab.
2. Open `schema.sql`, select all the text and copy it.
3. Paste it into the console box and tap **Execute**.
4. You should see success messages. Tap **Tables** to confirm you have `qualified_entries`, `disqualified_entries`, `permanent_blacklist`, `system_config` and `live_alerts`.

If the console rejects the whole script at once, paste it in two parts: first everything down to the last `CREATE INDEX` line, then the `INSERT` lines. The script is safe to run again; it never overwrites values you already changed.

### Step 3. Put the files on GitHub

1. On github.com tap **+** > **New repository**. Name it, set it to **Private**, tap **Create repository**.
2. Tap **Add file** > **Create new file**. In the name box type the full path, for example `functions/api/submit.js`. Typing a `/` creates the folder. Paste the file contents and tap **Commit changes**.
3. Repeat for every text file: the three files in `functions/api/`, `schema.sql`, `README.md`, the three `.html` files and the three `.js` files in `public/` (type `public/index.html`, `public/js/portal-engine.js`, and so on).
4. For the images and audio, which cannot be pasted: first create a placeholder such as `public/images/.gitkeep` so the folder exists, open that folder in GitHub, tap **Add file** > **Upload files**, choose the PNGs, and commit. Do the same inside `public/audio/` for the MP3s.

Tip: if you have a computer later, drag the whole folder into GitHub's upload page in one go.

### Step 4. Create the Pages project

1. In Cloudflare go to **Workers & Pages** > **Create application**.
2. Near the bottom, tap the **Looking to deploy Pages? Get started** link, then **Connect to Git**.
3. Authorize GitHub, pick your repository and tap **Begin setup**.
4. Fill in the build settings:
   - **Framework preset:** None
   - **Build command:** leave empty
   - **Build output directory:** `public`
5. Tap **Save and Deploy**.

The output directory must be `public`. If you leave it blank, Cloudflare would publish the whole repository, including `schema.sql`.

### Step 5. Bind the database as `DB`

1. Open your Pages project > **Settings** > **Bindings**.
2. Tap **Add** > **D1 database**.
3. **Variable name:** `DB` (capital letters, exactly this).
4. **D1 database:** choose `wheel-spin-db`.
5. Tap **Save**. If the page asks which environment, add it for **Production**, and for **Preview** too if you plan to test branches.

### Step 6. Add the admin key

1. Still in **Settings**, open **Variables and Secrets** and tap **Add**.
2. **Type:** Secret. **Variable name:** `ADMIN_TOKEN`.
3. **Value:** a long random phrase only you know (20+ characters). Save it in a password manager.
4. Tap **Save**.

### Step 7. Redeploy so the bindings take effect

Go to **Deployments**, tap the three-dot menu on the latest deployment and choose **Retry deployment** (or commit any small change on GitHub). Wait for it to show **Success**.

### Step 8. Use it

| Page | Who | Address |
| --- | --- | --- |
| Entry portal | Viewers | `https://YOUR-PROJECT.pages.dev/` |
| Stream wheel | OBS / TikTok LIVE Studio window | `https://YOUR-PROJECT.pages.dev/wheel.html` |
| Control panel | You only | `https://YOUR-PROJECT.pages.dev/admin.html` |

- Open `wheel.html` on the stream machine and tap **START BROADCAST** once. Browsers block sound until a click.
- Open `admin.html` and type your admin key. You can also open `admin.html?token=YOUR_KEY` once; the key is removed from the address bar immediately. Typing it is safer because links can stay in browser history.

---

## Running a show

1. Open registration (it starts open). Viewers enter through the portal.
2. Watch the green board fill up. The red board lists anyone caught entering twice.
3. **🏆 Declare Winner Mode** runs the drumroll, spins, and crowns a winner with the victory theme.
4. **❌ Matirang Matibay Mode** spins and crosses the landed player out on the stream log only. The database keeps their record. Use it repeatedly for an elimination game, then use Winner Mode when few remain.
5. **🔄 Reset Wheel** makes the stream display reload from the database and forget all local eliminations.
6. **🧽 Wipe D1 Table** clears entries, cheaters and alerts for a new event. The permanent blacklist is kept.
7. **Close Registration** stops new submissions instantly, before any other check.

Eliminations are stored in the stream browser's memory (mirrored to its local storage so a refresh does not undo them). Another browser showing `wheel.html` will not know about them.

## Changing verification values later

Open the D1 **Console** and run, for example:

```sql
UPDATE system_config SET config_value = 'newname' WHERE config_key = 'fan_club_name';
UPDATE system_config SET config_value = '10' WHERE config_key = 'min_level';
UPDATE system_config SET config_value = '7' WHERE config_key = 'cooldown_days';
UPDATE system_config SET config_value = 'true' WHERE config_key = 'require_handle_match';
```

`require_handle_match` (default `false`) makes the server also require the player's TikTok username to appear in the screenshot text. Turn it on only if your screenshot layout shows the handle clearly.

## Replacing the placeholder media

Upload your own files with the same names to `public/images/` and `public/audio/` (GitHub: open the file, then the pencil menu or **Add file** > **Upload files**, and commit). Missing audio files never break the show; sound is simply skipped.

---

## Honest limits you should know about

- **The scan runs on the viewer's device, so the server cannot prove it ran.** Someone technical could skip the portal and send made-up text straight to `/api/submit`. The server still checks that text against your database values, which stops casual cheating but not a determined person. The blacklist, the manual review of the green board, and `require_handle_match` are your tools for that.
- **The duplicate trap can be abused.** Anyone who knows a player's Roblox name and can produce passing text can trigger that player's disqualification. If it happens to an innocent player, add them back with the **Manual Injection** box, which also lifts their cooldown.
- **The geometry check is a heuristic.** It flags lines whose text boxes have mismatched baselines and heights. The thresholds are constants at the top of `portal-engine.js` and were not tuned against real TikTok screenshots, so test with a few genuine ones. A false alarm only shows "Verification Failed" and the player may retry; nobody is banned by it.
- **AI-image blocking only catches images that still carry their provenance metadata.** Screenshots of AI images, or images stripped of metadata, pass this particular check.
- **Usernames follow your strict pattern** (`letters, numbers, underscore`, 3 to 20 characters). TikTok handles that contain a period will be rejected by design.
- **Tesseract.js loads from the jsDelivr CDN** the first time someone submits. It is a script library only, not a data service. Nothing about the entry leaves Cloudflare except that library download.
- **The local "entry done" lock is a courtesy.** Clearing browser data removes it. The database is the real gate.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Pages show but entries fail with "Database binding is not configured" | Step 5 and 7: binding name must be exactly `DB`, then redeploy. |
| Admin says "ADMIN_TOKEN is not configured" | Step 6, then redeploy. |
| `/api/...` returns 404 | The `functions` folder must be at the **root** of the repository, not inside `public`. |
| `schema.sql` downloads from your site | Build output directory is not set to `public`. Fix it in **Settings** > **Builds** and redeploy. |
| Wheel never spins | Open `wheel.html` and make sure the **START BROADCAST** overlay is gone; check Admin shows players on the wheel. |
| Everyone gets "Verification Failed" | Check the values in `system_config`, and try a screenshot where the badge text is large and sharp. |

## For desktop users

You can skip GitHub with Wrangler. From this folder: `npx wrangler pages deploy public --project-name YOUR-PROJECT`. Wrangler picks up the `functions` folder next to `public`. Bindings are still set in the dashboard as in Steps 5 and 6.
