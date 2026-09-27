# Connecting Supabase

Vertex Chart Scanner uses Supabase for accounts: sign up, log in and log out. Supabase stores the users and handles passwords, so none of that lives in this code. This guide takes about 15 minutes.

You need a free Supabase account at https://supabase.com.

## 1. Create the project

1. Log in to Supabase and click **New project**.
2. Name it `chart-scanner`.
3. Set a strong database password and save it in your password manager. You will not need it for this app, but you will need it later if you ever connect to the database directly.
4. Pick the region closest to your customers. For South Africa that is usually **Europe (Frankfurt)** or **Europe (London)**.
5. Click **Create new project** and wait a minute or two for it to finish.

## 2. Copy the two keys this app needs

1. In the project, open **Project Settings** then **API**. (In some versions of the dashboard it is under **Project Settings** then **API Keys** and **Data API**.)
2. Copy the **Project URL**. It looks like `https://abcdefghijkl.supabase.co`.
3. Copy the **anon public** key (it may be labelled **publishable**). It is a long string.

> **Never use the `service_role` key (or `secret` key) in this app.** That key skips every security rule in Supabase. The anon key is safe to be public because Supabase limits what it can do. The service_role key is not.

## 3. Put the keys in `.env`

Open `server/.env` and fill in the two lines:

```
SUPABASE_URL=https://abcdefghijkl.supabase.co
SUPABASE_ANON_KEY=paste-the-anon-public-key-here
```

Restart the server:

```
cd server
npm start
```

The server always reads `server/.env` (the file next to `server.js`), so it does not matter which folder you start it from. Values set as real environment variables on a host take priority over the file.

The warning that says "Supabase is not configured" should be gone. If it is still there, the warning now says which value is the problem (missing, still the placeholder, too short, or a `service_role` key). It never prints the value itself. You can also open `http://localhost:3000/api/health`: it shows `"accounts": true` once the keys are accepted.

## 4. Tell Supabase where the site lives

Supabase only sends people back to addresses you have approved. Without this, confirmation emails and password links will not work.

1. Open **Authentication** then **URL Configuration**.
2. Set **Site URL** to where the site runs.
   * While testing on your computer: `http://localhost:3000` (the default port; if you change `PORT` in `.env`, use that port here instead)
   * Once it is live: your real address, for example `https://yourdomain.com`
3. Under **Redirect URLs**, click **Add URL** and add each of these:
   * `http://localhost:3000/**`
   * `https://yourdomain.com/**` (once you have a domain)
4. Save.

Always open the site as `http://localhost:3000`, not `http://127.0.0.1:3000`. The links in confirmation emails point back to whichever address you signed up from, and only addresses listed here are allowed.

## 5. Decide on email confirmation

Open **Authentication** then **Sign In / Providers** then **Email**.

**Confirm email ON** (recommended once live)
New users get an email with a link and cannot log in until they click it. This stops people signing up with fake emails. The sign up page shows a "Check your email" screen for this.

**Confirm email OFF** (easiest while testing)
New users are logged in straight away and land in the scanner.

The app handles both. Nothing in the code needs to change.

## 6. Set up proper email before launch

Supabase's built in email is only meant for testing. It sends very few emails per hour and they often land in spam. Before real customers sign up:

1. Create an account with an email provider such as Resend, Brevo or Postmark and verify your domain there.
2. In Supabase open **Project Settings** then **Authentication** then **SMTP Settings**, turn on **Enable custom SMTP** and enter the details from the provider.
3. Optional but worth it: under **Authentication** then **Emails**, edit the templates so they say Vertex Chart Scanner and match your brand.

## 7. Test it

1. Open `http://localhost:3000` and click **Sign up**.
2. Create an account with a real email you can check.
3. If confirmation is on, open the email and click the link.
4. You should land in the scanner with your email and a **Log out** button at the top.
5. Log out, then log back in from `/login`.
6. Open `http://localhost:3000/app` in a private window. It should send you to the log in page.

You can see every user under **Authentication** then **Users** in Supabase. You can delete test accounts from there.

## When the site goes live

Wherever the site is hosted (Render, Railway, a VPS), add these as environment variables on the host instead of using a `.env` file:

```
ANTHROPIC_API_KEY
SUPABASE_URL
SUPABASE_ANON_KEY
CORS_ORIGIN        (your live address, for example https://yourdomain.com)
```

Then update the **Site URL** and **Redirect URLs** in step 4 to the live address.

## How the security works (short version)

1. The browser logs in with Supabase and gets an access token.
2. Every scan sends that token to our server.
3. Our server asks Supabase "who is this?" before it spends any money on the AI.
4. No valid token means no scan. Someone who finds the site cannot use it without an account, and cannot fake an account by editing the page.

## Common problems

| What you see | What to do |
|---|---|
| "Accounts are not connected yet" | The keys in `server/.env` are missing, still the placeholders, or not accepted. Read the `[WARN]` line in the terminal when the server starts: it says which one. Fix it and restart the server. |
| "Could not load the sign in tools" | The browser could not download the Supabase script (offline, or blocked by an extension or network). Check the connection and refresh. |
| "Could not load the site settings" | The page could not reach the server. Make sure it is running. |
| Confirmation link opens a page that says the link is invalid | The address is not in **Redirect URLs** (step 4), or the link was already used or has expired. |
| "Please confirm your email first" when logging in | Confirmation is on and the link has not been clicked. Check spam. |
| No email arrives | The built in email limit was hit. Set up custom SMTP (step 6), or turn confirmation off while testing. |
| "Could not verify your account right now" when scanning | The server cannot reach Supabase. Check `SUPABASE_URL` is right and the project is not paused. Free projects pause after a week without activity; resume it from the dashboard. |
