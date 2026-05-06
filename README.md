# Electronics Part Lookup Agent

A full-stack electronics intelligence app powered by a Lyzr agent, supplier APIs, and datasheet parsing.

The application has a React/Vite frontend and an Express backend designed to run locally during development and deploy cleanly to Render.

## Features

- Lyzr-powered chat assistant for electronics part questions
- Mouser lookup, keyword search, part comparison, and product-page specs
- DigiKey keyword search and part lookup
- Datasheet PDF parsing for spec questions that are not available in supplier API fields
- Context-aware chat flow so follow-up questions stay attached to the latest part or search
- Dark professional UI with product cards and active context
- Backend-only handling for API credentials

## Architecture

```text
client/   React + Vite frontend
server/   Express + TypeScript backend
```

The frontend calls the backend. It does not call supplier APIs or Lyzr directly.

## Backend API

```text
GET  /api/health
GET  /api/healthz
POST /api/lookup-part
POST /api/search-keyword
POST /api/compare-parts
POST /api/product-page-specs
POST /api/digikey-search
POST /api/digikey-lookup
POST /api/lyzr-chat
POST /api/datasheet-answer
```

## Local Development

Create a local `server/.env` file with the backend credentials and runtime settings. Do not commit env files.

Run the backend:

```powershell
cd server
npm install
npm run dev
```

The backend runs on:

```text
http://localhost:5000
```

Health check:

```powershell
Invoke-RestMethod -Uri http://localhost:5000/api/health
```

Run the frontend:

```powershell
cd client
npm install
npm run dev
```

The frontend runs on:

```text
http://localhost:5173
```

## Render And Vercel Deployment

Deploy the backend as a Render Web Service.

```text
Root Directory: server
Build Command: npm install && npm run build
Start Command: npm start
Health Check Path: /api/health
```

Configure backend credentials in the Render environment variable dashboard. Render provides `PORT` automatically. Set `CLIENT_ORIGIN` to the production Vercel frontend origin, for example `https://your-app.vercel.app`.

Deploy the frontend on Vercel.

```text
Root Directory: client
Build Command: npm run build
Output Directory: dist
```

Set the Vercel frontend environment variable `VITE_API_BASE_URL` to the Render backend origin, for example `https://your-api.onrender.com`. Do not include `/api` in this value.

If the Lyzr agent has tools, webhooks, or API actions that still point to an old backend URL, update those URLs in the Lyzr agent configuration to the Render backend URL. The frontend already talks to Render through `VITE_API_BASE_URL`; Lyzr-side tool URLs are configured in Lyzr, not in this React app.

## Notes

- Secrets are loaded from local `.env` during development and from Render environment variables in production.
- `.env`, build output, dependency folders, and logs are ignored by git.
- The backend is the only place that touches supplier and Lyzr credentials.
