# SNT Homework / Task Submission App

A simple GitHub-ready web app for homework/task submissions using Supabase.

## What it includes

### Student View
- Secure email login
- Approved-student check
- Tasks list
- Search and status filters
- Open task screen
- Teacher instructions / text / image / link
- Student written answer box
- Student image upload preview
- Submit task button
- Teacher feedback display

### Teacher View
- Manage Tasks
- Add New Task
- Hide/show tasks
- Approve/block student emails
- View Submissions
- Review student answer and uploaded images
- Add review status and feedback
- PDF export preview using browser Print / Save as PDF

## Important security note

This is a static front-end app for GitHub Pages / Netlify / Vercel.

✅ Safe to use in public front-end:
- Supabase URL
- Supabase anon / publishable key

❌ Never put this in the front-end:
- Supabase service_role key
- Database password
- Secret API keys
- Hidden answer keys

The real protection is done by Supabase Row Level Security policies in `supabase-schema.sql`.

## Setup steps

### 1. Create Supabase project

Create a project at Supabase and wait for it to finish provisioning.

### 2. Run database setup

Open:

`Supabase Dashboard -> SQL Editor -> New query`

Paste everything from:

`supabase-schema.sql`

At the bottom of that SQL file, uncomment and change this line:

```sql
insert into public.teacher_users (email, active)
values ('your-teacher-email@example.com', true)
on conflict (email) do update set active = true;
```

Use your real teacher email in lowercase, then run the SQL.

### 3. Add Supabase config

Copy:

`config.sample.js`

Rename/copy it as:

`config.js`

Then add your Supabase details:

```js
window.SNT_SUPABASE_URL = 'https://your-project-ref.supabase.co';
window.SNT_SUPABASE_ANON_KEY = 'your-publishable-key';
```

You find these in:

`Supabase Dashboard -> Project Settings -> API`

### 4. Configure Supabase Auth redirect URLs

In Supabase:

`Authentication -> URL Configuration`

Set your Site URL to your deployed address, for example:

```text
https://yourusername.github.io/snt-homework-app/
```

Add the same URL to Redirect URLs.

For local testing, also add:

```text
http://localhost:8080/
```

### 5. Enable email magic links

In Supabase:

`Authentication -> Providers -> Email`

Make sure Email provider is enabled.

### 6. Test locally

From the app folder, run:

```bash
python3 -m http.server 8080
```

Open:

```text
http://localhost:8080
```

Login using the teacher email you inserted in SQL.

### 7. Approve students

Teacher View -> Approved Students -> add student email.

Students must login with exactly that approved email.

### 8. Upload to GitHub

Upload these files:

```text
index.html
styles.css
app.js
config.js
manifest.webmanifest
supabase-schema.sql
README.md
```

Then enable GitHub Pages:

`GitHub repo -> Settings -> Pages -> Deploy from branch`

## How PDF export works

Teacher View -> View Submissions -> click:

`PDF export preview / Print`

Then choose:

`Save as PDF`

The app uses browser print styling, so no paid PDF library is needed.

## Common problems

### Student logs in but sees “Not approved yet”

The teacher must add the student's exact lowercase email under Approved Students.

### Images do not upload

Check that:
- The SQL file was run fully.
- The `submission-images` bucket exists.
- Storage RLS policies were created.
- The student is approved.
- The image is under 10 MB.

### Magic link opens but user is not logged in

Check Supabase Auth Redirect URLs. Your deployed GitHub Pages URL must be added exactly.

## Suggested next upgrade

For a larger school setup, add:
- Classes/groups
- Task assignment by grade/class
- Multiple teachers
- Student name/profile table
- Bulk CSV student import
- Notification emails


## Your current Supabase values

The app is now configured with this project URL:

```js
window.SNT_SUPABASE_URL = 'https://ejnkopeekfiedzjgyyiv.supabase.co';
```

The project ref shown in Supabase Project Settings is used inside the URL like this:

```text
https://PROJECT-REF.supabase.co
```

Only the publishable/anon key belongs in `config.js`. Do not add a `sb_secret_...` key to any GitHub file.
