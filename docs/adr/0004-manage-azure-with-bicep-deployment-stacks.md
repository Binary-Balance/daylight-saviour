---
status: accepted
---

# Manage Azure infrastructure with Bicep Deployment Stacks

All supporting Azure resources will be defined in Bicep and applied through subscription- or resource-group-scope Deployment Stacks. Deployments from the private operations repository will use GitHub Actions with workload identity federation, environment protection, what-if validation, and least-privilege deployment identities; no Azure deployment credentials will be committed or stored as long-lived GitHub secrets.

## Consequences

- Bicep validation and deployment-stack what-if run in CI before changes are applied.
- Environment-specific values remain parameters; secret values are provisioned through controlled data-plane operations rather than committed parameter files.
- Stack deny settings and unmanaged-resource behavior must be chosen explicitly before production deployment.
- Production deployment requires a protected GitHub Environment and trusted-branch approval.
