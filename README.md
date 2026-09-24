# AVATAR Universal AI Sales CRM

Monorepo with two apps:

| App | Folder | Stack | Default URL |
|---|---|---|---|
| Backend API | [backend/](backend/) | Express 5, TypeScript, Prisma 7 (Neon Postgres) | http://localhost:5000 |
| Frontend | [frontend/](frontend/) | Next.js 16, React 19, Tailwind 4 | http://localhost:3000 |

## Prerequisites

- Node.js 20.19+ (22 LTS recommended) and npm
- A PostgreSQL connection string (Neon) for the backend

Run the backend and the frontend in **two separate terminals**.

---

## Backend

```bash
cd backend
npm install
```

### Environment

Create `backend/.env` from the example and fill in the values:

```bash
# Git Bash / macOS / Linux
cp .env.example .env

# PowerShell
Copy-Item .env.example .env
```

| Variable | Meaning |
|---|---|
| `DATABASE_URL` | Neon Postgres connection string |
| `PORT` | API port (default `5000`) |
| `FRONTEND_URL` | Allowed CORS origin (default `http://localhost:3000`) |

### Generate the Prisma client

Required after a fresh clone and after any change to `backend/prisma/schema/*.prisma`. The client is generated into `backend/generated/prisma` (git-ignored).

```bash
npm run db:generate
```

### Run in development

```bash
npm run dev
```

Check that it works: http://localhost:5000/api/health should return `{"success":true,"message":"ok"}`.

### Build and run for production

```bash
npm run build
npm start
```

### Database scripts

| Command | What it does |
|---|---|
| `npm run db:generate` | Regenerate the Prisma client |  
| `npm run db:migrate` | `prisma migrate dev`: creates and applies a new migration. **Runs against the database in `DATABASE_URL`, so make sure it is not a shared database.** |
| `npm run db:deploy` | `prisma migrate deploy`: applies existing migrations only |

---

## Frontend

```bash
cd frontend
npm install
npm run dev
```

Open http://localhost:3000.

| Command | What it does |
|---|---|
| `npm run dev` | Start the dev server |
| `npm run build` | Production build |
| `npm start` | Serve the production build (run `npm run build` first) |
| `npm run lint` | Run ESLint |

---

## Quick start (both apps)

Terminal 1:

```bash
cd backend && npm install && npm run db:generate && npm run dev
```

Terminal 2:

```bash
cd frontend && npm install && npm run dev
```

## Troubleshooting

- **Port already in use:** change `PORT` in `backend/.env`, or stop the process using it. For the frontend, run `npx next dev -p 3001` and update `FRONTEND_URL` in `backend/.env` to match, otherwise CORS will block requests.
- **`Cannot find module '../../generated/prisma/client.js'`:** run `npm run db:generate` in `backend`.
- **CORS error in the browser:** `FRONTEND_URL` in `backend/.env` must exactly match the frontend origin.
Your complete home workflow

1. Clone

git clone "GIT_URL"
cd "PROJECT_FOLDER"

2. Switch to your branch

git checkout dev-vishwa

3. Backend setup

cd backend
npm i
npx prisma generate
npm run dev

Keep backend running.

4. Frontend — open a second VS Code terminal

cd frontend
npm i
npm run dev

5. Do your E6 implementation/testing

Make all your changes on dev-vishwa.

6. Before you finish your work

First check what changed:

git status

Then:

git fetch origin
git merge origin main

This brings the latest main changes into your dev-vishwa branch.

7. If merge has NO conflicts

Check:

git status

Then test the application again:

cd backend
npm run dev

and in another terminal:

cd frontend
npm run dev

Run the relevant tests/typecheck if your implementation requires them.

8. Commit your work
git add .
git commit -m "feat(e6): <short description>"

Do NOT push to main.

If your developer wants you to push your branch:

git push origin dev-vishwa

Otherwise, stop after the commit and tell your developer that E6 changes are committed on dev-vishwa.

⚠️ Important for your current E6 work

Because your developer specifically told you to merge main before finishing:

Do the merge BEFORE your final commit, not after:

dev-vishwa
   ↓
make E6 changes
   ↓
git fetch origin
   ↓
git merge origin main
   ↓
resolve conflicts if any
   ↓
test E6
   ↓
git add .
   ↓
git commit
   ↓
developer reviews/merges to main

If the merge gives you a conflict, don't randomly choose "ours" or "theirs". Send me the conflict output and I'll tell you exactly what to do.