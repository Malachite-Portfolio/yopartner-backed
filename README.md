# YoPartner Backend (`yopartner-backed`)

Railway-ready backend for YoPartner using:
- Node.js + Express + TypeScript
- Prisma + PostgreSQL
- Firebase Admin SDK token verification
- Role-based access (`USER`, `PARTNER`, `ADMIN`)

## Features Implemented

- Firebase token auth middleware (`Bearer <idToken>`)
- Role middleware with optional admin allowlist bootstrap
- Companion APIs
- Partner onboarding and dashboard APIs
- Booking/session APIs (Chat/Audio/Video only)
- Wallet and recharge verification structure APIs
- Admin operations APIs
- Agora RTC/Chat token APIs

No demo data seeding is included.

## Local Setup

1. Install:
```bash
npm install
```

2. Configure env:
```bash
cp .env.example .env
```

3. Generate Prisma client:
```bash
npm run prisma:generate
```

4. Create/apply migrations:
```bash
npx prisma migrate dev --name init
```

5. Run dev server:
```bash
npm run dev
```

Server default: `http://localhost:8080`

## Railway Deployment

1. Create Railway project.
2. Add PostgreSQL plugin/service.
3. Add backend service from this repo.
4. Add all env vars from `.env.example`.
5. Set deploy/start commands:
   - Build: `npm run build`
   - Start: `npm run start`
6. Run migrations on Railway:
   - `npm run prisma:generate`
   - `npm run prisma:migrate`
7. Set frontend `NEXT_PUBLIC_API_BASE_URL` to Railway backend URL.

## API Groups

- `GET /health`
- `GET /api/auth/me`
- `GET /api/companions`
- `GET /api/companions/featured`
- `GET /api/companions/:id`
- `POST /api/partner/applications`
- `GET /api/partner/applications/me`
- `GET /api/partner/dashboard`
- `GET/PATCH /api/partner/profile`
- `GET /api/partner/bookings`
- `GET /api/partner/sessions`
- `GET /api/partner/earnings`
- `GET/POST /api/bookings`
- `PATCH /api/bookings/:id/cancel`
- `GET/POST /api/sessions`
- `PATCH /api/sessions/:id/end`
- `PATCH /api/sessions/:id/flag`
- `GET /api/wallet`
- `GET /api/wallet/transactions`
- `POST /api/wallet/recharge-order`
- `POST /api/wallet/verify-recharge`
- `GET/PATCH admin endpoints under /api/admin/*`
- `POST /api/agora/token/rtc`
- `POST /api/agora/token/chat`

## Notes

- User-facing APIs intentionally exclude Home Visit.
- Payment gateway verification is structured but gateway signature validation should be finalized in production.
- For admin bootstrap in production, set `ADMIN_UID_ALLOWLIST` and/or `ADMIN_PHONE_ALLOWLIST` once, then rely on DB roles.
