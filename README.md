# GODSHOOTSPRIME website

A single-page static site: black-first portfolio, a three-step "how booking works" section, and a five-step inquiry that ends with the client's email so you can send a quote. No build step. It's made for Vercel: the pages are static, and the two small server functions in `api/` connect Backblaze (see "Going live" below).

All settings are in the `SETTINGS` block at the top of the script in `index.html`.

## Receiving inquiries (do this before going live)

1. Create a free account at https://formspree.io and make a new form.
2. Copy its endpoint (looks like `https://formspree.io/f/abcdwxyz`).
3. Paste it into `FORM_ENDPOINT` in `index.html`.

Every inquiry then arrives in your inbox with the category, details, date, location, budget, notes, name, email, phone and whether they want updates. The client's email is set as reply-to, so you can reply straight to the email with your quote.
While `FORM_ENDPOINT` is empty the form runs in preview mode: it shows the thank-you screen but sends nothing.

Budget ranges are in `CURRENCY_BUDGETS` if you want a different currency or ranges.

## Your photos

Once Backblaze is connected (see "Going live"), the site loads your portfolio straight from the website bucket and the files below are only a fallback.

- Hero image: `images/hero.jpg`
- Galleries: `images/events/01.jpg` ... `06.jpg`, and the same for `couples`, `fashion`, `boudoir`.
- Change captions or add more photos in the `GALLERIES` list. Any photo that can't be found shows a grey placeholder.
- Export around 2400px on the long edge, JPEG quality ~80.

## Contact details

Edit `CONTACT` (email and Instagram shown in the footer).

## Client galleries (client.html + admin.html)

Clients sign in at `client.html` with their folder's password. Each folder has three sections: **Select** (proofs they tick and send back), **Finals** (edited images) and **Downloads** (JPEGs). The main site links to it as "Clients" and "Client login".

You manage everything at `admin.html` (also linked as "Photographer sign-in" under the client sign-in). The first visit asks you to set an admin password. From there you can:
- Make a folder per client or event, set its password, shoot details and date.
- Upload photos into Proofs, Finals and Downloads (drag and drop or choose files).
- Set how many edits they can select and how many photos they can download.
- Turn the download timer on or off and set its number of days (counted from the client's first sign-in), restart it, or reopen it.
- Turn on a share link for events: anyone with the link gets in without a password and sees Finals and Downloads.
- See the selection a client sent, and copy the file names.
- Change any wording, per folder or as a site-wide default (Site text & settings).

### Contracts and messages

Each client folder in the admin portal also has:
- **Contract:** write or paste an agreement (it starts from your template in Site text & settings, filled in with the client's name, shoot, date and location) and send it. The client reads it in their gallery under Contract and signs with their typed name and a drawn signature. Sent contracts can't be edited, only withdrawn while unsigned. Signed ones show who signed and when, and can be printed or saved as PDF.
- **Messages:** a back-and-forth with the client. They write under Messages in their gallery and you reply in their folder.

Notifications: the admin portal shows a "new messages" badge and tags each folder. In Site text & settings you can turn on desktop alerts, and add a Formspree endpoint to get an email whenever a client messages you, signs or sends a selection. Formspree works today, even before the backend is connected.

The sample contract template is a starting point only. Have a lawyer review your terms.

**Preview mode.** Until Backblaze is connected, everything is saved in the browser you're using, with a demo client (password `demo`). That's handy for trying things out, but clients on other devices can't see it. Once the steps below are done, the pages switch to live mode on their own.

## Going live: Vercel + Backblaze + Google sign-in

Nothing secret ever goes in the pages. The Backblaze keys and your admin password live in Vercel's settings, and only the functions in `api/` can read them.

### 1. Backblaze (B2 Cloud Storage, not Personal Backup)

Two private buckets:
- **Website bucket** (e.g. `godshootsprime-site`): top-level folders `events`, `couples`, `fashion`, `boudoir`. Photos you drop in show up on the site within about an hour, in file-name order (start names with `01-`, `02-` to set the order). A name like `03-golden-hour.jpg` becomes the caption "Golden hour"; camera names like `IMG_1234.jpg` get no caption. Put `hero.jpg` at the top of the bucket for the front-page photo.
- **Portal bucket** (e.g. `godshootsprime-portal`): leave it empty. The site fills it with client folders, photos, contracts and messages.

Then **Application Keys → Add a New Application Key**, twice:
- `site-read`: only the website bucket, **Read Only**.
- `portal`: only the portal bucket, **Read and Write**.

Each shows a **keyID** and an **applicationKey** once. Copy both straight into Vercel (next step). Also note the bucket's **Endpoint** on the Buckets page (looks like `s3.us-west-004.backblazeb2.com`).

### 2. Google sign-in for clients

1. https://console.cloud.google.com → new project "GODSHOOTSPRIME".
2. **APIs & Services → OAuth consent screen**: External, app name GODSHOOTSPRIME, your Gmail as support email. Publish it.
3. **Credentials → Create credentials → OAuth client ID → Web application**. Authorized JavaScript origins: `https://godshootsprime.com` and `https://www.godshootsprime.com`.
4. Copy the **Client ID** (ends in `.apps.googleusercontent.com`).

In each client folder in the admin portal, type the client's Gmail (or any Google account email) under "Client emails for Google sign-in". They tap **Continue with Google** and land in their gallery. The folder password still works too.

### 3. Vercel environment variables

Project → Settings → Environment Variables:

| Name | Value |
|---|---|
| `B2_ENDPOINT` | the endpoint, e.g. `s3.us-west-004.backblazeb2.com` |
| `PORTAL_BUCKET` | portal bucket name |
| `PORTAL_KEY_ID` / `PORTAL_KEY` | the `portal` keyID / applicationKey |
| `SITE_BUCKET` | website bucket name |
| `SITE_KEY_ID` / `SITE_KEY` | the `site-read` keyID / applicationKey |
| `ADMIN_PASSWORD` | your admin portal password (long) |
| `SESSION_SECRET` | any long random text |
| `GOOGLE_CLIENT_ID` | the Google Client ID |

Redeploy after adding them.

### 4. Finish setup (one click)

Sign in at `godshootsprime.com/admin.html` → Site text & settings → **Storage & sign-in → Finish setup**. This lets browsers upload to and read from the portal bucket (CORS). If it asks for a master key, paste the **Master Application Key** keyID and key from Backblaze. It's used once and never saved.

### 5. Email

Everything goes to godshootsprime@gmail.com: in Formspree, use that address, paste the form endpoint into `FORM_ENDPOINT` in `index.html` (inquiries) and into "Email notifications" in the admin settings (messages, signatures, selections).
