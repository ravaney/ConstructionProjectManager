# Dream Home Construction Tracker

Responsive full-stack React app for managing dream-home construction finances and execution.

## Features

- Authentication and roles (`OWNER`, `CONTRACTOR`)
- Budget dashboard (burn rate, category totals, monthly spend)
- Expense tracking with inline edit and role-based delete permissions
- Project task board with inline edit and status workflow
- Attachment uploads for expenses/tasks
  - Cloudinary storage when configured
  - Local file storage fallback when Cloudinary is not configured
- Reports
  - Monthly CSV export
  - Monthly PDF export
  - Budget and spend alerts
- Team management (owner can add users)
- CSV importer for existing worksheet format (`Item`, `Category`, `Amount`)

## Project structure

- `client/` - React + Vite
- `server/` - Express + TypeScript + MongoDB

## 1) Install dependencies

```bash
npm install
```

## 2) Configure environment variables

### Backend (`server/.env`)

Copy `server/.env.example` to `server/.env` and set:

- `MONGODB_URI`
- `PORT` (default `4000`)
- `CLIENT_ORIGIN` (default `http://localhost:5175`)
- `JWT_SECRET` (required)
- `TOKEN_TTL` (default `7d`)

Optional for cloud attachments:

- `CLOUDINARY_CLOUD_NAME`
- `CLOUDINARY_API_KEY`
- `CLOUDINARY_API_SECRET`

Fallback local upload config:

- `UPLOAD_DIR` (default `uploads`)

### Frontend (`client/.env`)

Copy `client/.env.example` to `client/.env` and set:

- `VITE_API_URL=http://localhost:4000/api`

## 3) Run app

```bash
npm run dev
```

- Frontend: `http://localhost:5175`
- Backend: `http://localhost:4000`

## 4) First login flow

- Open frontend URL
- If no users exist: create owner account from the auth screen
- If users exist: login with email/password

## 5) Reports and alerts

- Open `Financials -> Reports`
- Select month and download CSV/PDF
- Refresh alerts to check over-budget and spike warnings

## API highlights

- `POST /api/auth/register`
- `POST /api/auth/login`
- `GET /api/auth/me`
- `GET /api/auth/users`
- `POST /api/auth/users`
- `GET /api/attachments`
- `POST /api/attachments/upload`
- `DELETE /api/attachments/:id`
- `GET /api/reports/monthly.csv`
- `GET /api/reports/monthly.pdf`
- `GET /api/reports/alerts`