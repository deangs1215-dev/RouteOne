# RouteOne

> **Enterprise B2B Field Sales CRM & Sales Enablement Platform**  
> Developed by **Navex**

RouteOne is a modern field sales platform built for manufacturers, wholesalers, and distributors. It provides sales representatives with everything they need while visiting customers, including customer information, product catalogues, pricing, quotations, sales order capture, visit management, route planning, GPS tracking, analytics, and AI-assisted selling.

RouteOne integrates with **SYSPRO ERP** while providing a modern, mobile-first user experience. SYSPRO remains the master business system, with RouteOne acting as the operational platform for field sales teams.

---

# Vision


The long-term vision of RouteOne is to become the primary application used by every salesperson throughout their working day.

The platform is designed around five key principles:

- Mobile-first
- Fast and intuitive
- Enterprise scalable
- Offline capable
- Easy to maintain and extend

---

# Current Features

RouteOne currently includes:

### Customer Management

- Customer profiles
- Contacts
- Credit limits
- Customer grading
- Sales history
- Customer pricing
- GPS locations

### Product Management

- Product catalogue
- Categories
- Pricing
- Contract pricing
- Stock availability
- Barcode scanning

### Sales

- Quotations
- Sales orders
- Repeat orders
- Customer pricing
- Email order processing

### Field Sales

- Route planning
- Visit scheduling
- GPS check-in/out
- Customer notes
- Forms
- Photo uploads

### Business Intelligence

- Dashboards
- Sales KPIs
- Territory performance
- AI sales insights
- Churn prediction
- Product recommendations

### Customer Portal

- Customer ordering
- Quote acceptance
- Order tracking
- Account information

---

# Technology Stack

## Frontend

- React 18
- TypeScript
- Vite
- Tailwind CSS
- React Router

## Backend

- Node.js
- Express

## Database

- SQLite (Development)
- Microsoft SQL Server (Production / SYSPRO)

## Authentication

- JWT

---

# Project Structure

```text
client/                 React application

server/                 Express API

docs/                   Technical documentation

graphify-out/           Graphify knowledge graph

uploads/                Uploaded files

scripts/                Utility scripts

CLAUDE.md               AI development instructions

PROJECT_CONTEXT.md      Business knowledge

ROADMAP.md              Product roadmap

DECISIONS.md            Architecture decisions

CHANGELOG.md            Version history
```

---

# Development Environment

API

```
http://localhost:4200
```

Client

```
http://localhost:5190
```

Install dependencies

```bash
npm install
```

Seed demo database

```bash
npm run seed
```

Start development

```bash
npm run dev
```

---

# Demo Users

Password for all demo accounts:

```
demo123
```

| Email | Role | Landing Page |
|--------|------|--------------|
| admin@demo.co.za | Administrator | Back Office |
| manager@demo.co.za | Sales Manager | Back Office |
| office@demo.co.za | Internal Sales | Back Office |
| rep@demo.co.za | Field Representative | Mobile App |
| rep2@demo.co.za | Field Representative | Mobile App |
| customer@demo.co.za | Customer Portal | Customer Portal |

---

# SYSPRO Integration

RouteOne is designed to integrate with SYSPRO while allowing SYSPRO to remain the master system.

Current integrations include:

- Customers
- Products
- Pricing
- Contract Pricing
- Customer Balances
- Customer Terms
- Stock Availability

Sales Orders are currently submitted through the existing email workflow.

For complete integration details see:

```
docs/SYSPRO-INTEGRATION.md
```

---

# Development Roadmap

RouteOne has been designed around five major development phases.

These phases include:

- Core CRM
- Offline Capability
- Route Planning & GPS
- SYSPRO Integration
- Analytics & AI

For the complete feature breakdown see:

```
ROADMAP.md
```

---

# Documentation

| Document | Purpose |
|----------|---------|
| CLAUDE.md | AI development instructions and coding standards |
| PROJECT_CONTEXT.md | Business rules and project knowledge |
| ROADMAP.md | Product roadmap and planned features |
| DECISIONS.md | Architectural decisions and design principles |
| CHANGELOG.md | Version history |
| docs/API.md | API documentation |
| docs/DATABASE.md | Database documentation |
| docs/SYSPRO-INTEGRATION.md | SYSPRO integration |
| docs/DEPLOYMENT.md | Deployment guide |
| docs/SECURITY.md | Security documentation |

---

# Graphify

This project uses **Graphify** to maintain a searchable knowledge graph of the codebase.

Before manually searching the project for architecture or dependencies, use Graphify.

Typical commands:

```bash
graphify query "<question>"
```

```bash
graphify path "<Component A>" "<Component B>"
```

```bash
graphify explain "<concept>"
```

After making structural code changes:

```bash
graphify update .
```

---

# Contributing

When contributing to RouteOne:

- Follow the coding standards defined in `CLAUDE.md`
- Reuse existing components where possible
- Keep business logic outside UI components
- Write clean, maintainable TypeScript
- Update documentation when introducing new functionality
- Update Graphify after structural changes

---

# Project Status

**Status:** Active Development

The core platform has been architected and is continuously evolving. New functionality is added using an iterative approach with a strong focus on maintainability, scalability, and enterprise-grade reliability.