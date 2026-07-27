# RouteOne

## Purpose

RouteOne is an enterprise B2B Field Sales CRM developed by Navex.

It provides sales representatives with customer information, pricing, quotations, order capture, product information, visit planning and customer management while integrating with SYSPRO.

RouteOne complements SYSPRO and does not replace it.

---

## Core Principles

Always optimise for:

- Simplicity
- Performance
- Scalability
- Maintainability
- Mobile-first usability

Prefer extending existing functionality over creating duplicate functionality.

---

## Technology Stack

Frontend

- React
- TypeScript
- Tailwind CSS

Backend

- Node.js
- Express

Database

- Microsoft SQL Server

Authentication

- JWT

Hosting

- Windows Server (Current)
- Linux (Future)
- Cloud (Future)

---

## ERP Rules

SYSPRO is the master system.

RouteOne reads information from SYSPRO.

Do not directly update ERP tables unless specifically requested.

Customer pricing, balances, stock and history always originate from SYSPRO.

---

## Development Rules

Always:

- Use TypeScript.
- Parameterize SQL.
- Use async/await.
- Prefer reusable components.
- Keep business logic outside UI components.
- Never use SELECT *.
- Follow existing project patterns.

Before making significant architectural changes, explain the recommendation first.

---

## Graphify

This project maintains a Graphify knowledge graph.

Before investigating architecture:

- graphify query "<question>"
- graphify path "<A>" "<B>"
- graphify explain "<concept>"

After structural changes run:

graphify update .

---

## Documentation

For additional project knowledge refer to:

- README.md
- PROJECT_CONTEXT.md
- DECISIONS.md
- ROADMAP.md
- docs/

Always check existing documentation before introducing new architecture.