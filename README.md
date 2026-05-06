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

## Render Deployment

Deploy the backend as a Render Web Service.

```text
Root Directory: server
Build Command: npm install && npm run build
Start Command: npm start
Health Check Path: /api/health
```

Configure all backend credentials in the Render environment variable dashboard. Render provides `PORT` automatically.

Deploy the frontend as a Render Static Site or equivalent frontend host.

```text
Root Directory: client
Build Command: npm install && npm run build
Publish Directory: dist
```

Configure the frontend build to point at the deployed backend URL, and configure the backend CORS origin to allow the deployed frontend.

## Notes

- Secrets are loaded from local `.env` during development and from Render environment variables in production.
- `.env`, build output, dependency folders, and logs are ignored by git.
- The backend is the only place that touches supplier and Lyzr credentials.
