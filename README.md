# RINL Contract Labour Wage Sheet

A SQL-backed contract labour attendance and wage dashboard built during a 2025 internship at the Vizag Steel Plant (RINL).

## Data coverage

- December 2024, January 2025, and February 2025 have attendance records. Wage totals, absence calculations, and allowances are not stored for those months, so missing fields are shown as `NULL`.
- March 2025 has the existing worker wage records. Those stored values are shown as recorded.
- The app does not estimate or generate missing payroll values.

## Run locally

1. Install Node.js and MySQL, and make sure the existing database is available.
2. Keep the real database connection settings in `CODE/.env`. Never commit or share that file.
3. From this folder in VS Code, run `npm install` once and then `npm start`.
4. Open <http://127.0.0.1:4000> in a browser on the same computer.

Copy `.env.example` to `.env` only if setting up a new machine, then enter that machine's own database connection details. The SQL tables expected by this app are `Attendance`, `jobs`, `merged_worker_attendance`, and `worker_details_shyam`.

## Privacy and deployment

This repository contains application source only. It does not include the database, worker records, or `.env` credentials. The app binds to the local computer by default and masks Aadhaar numbers in API responses. Before hosting the backend, add authentication, HTTPS, and access controls, and use a private database connection. GitHub Pages can host static files but cannot run this Express and MySQL application.
