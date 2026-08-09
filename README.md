# TechPulse AI

## Step 1 local commands

The repository uses Node.js `24.14.1` and npm `11`. Run `nvm use` or select an equivalent Node 24 installation before working.

```text
npm ci
npm run dev              # http://localhost:3000
npm run contract:validate
npm run contract:generate
npm run contract:test
npm run lint
npm test -- --run
npm run build
```

Step 1 intentionally contains only the React/Vite shell, Express health boundary and contract tooling. MongoDB, authentication persistence, source connectors, provider adapters and business screens belong to later blueprint steps.
