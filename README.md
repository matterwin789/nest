# Nest

Minimal, mobile-first reminders app built with:
- React + Next.js (host on Vercel)
- Supabase Postgres (store todos)
- Dark mode UI from day one

## 1. Local setup

Install and run:

```bash
npm install
npm run dev
```

Create local environment values:

```bash
cp .env.example .env.local
```

Then set:

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`

## 2. Supabase setup

1. Create a Supabase project.
2. Open SQL Editor.
3. Run `/supabase/schema.sql`.
4. In Project Settings -> API, copy:
- Project URL -> `NEXT_PUBLIC_SUPABASE_URL`
- `anon public` key -> `NEXT_PUBLIC_SUPABASE_ANON_KEY`

## 3. GitHub + Vercel deployment

Yes, deploy from GitHub. That is the easiest and safest flow for iteration.

1. Push this project to a GitHub repo.
2. In Vercel, click **Add New Project** and import that repo.
3. Add environment variables in Vercel Project Settings:
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
4. Deploy.

Every push to `main` will auto-deploy.

## Notes

- This first cut allows anonymous CRUD via RLS policies in `supabase/schema.sql`.
- It is ideal for moving fast tonight, but you should add Supabase Auth + per-user policies before production.
