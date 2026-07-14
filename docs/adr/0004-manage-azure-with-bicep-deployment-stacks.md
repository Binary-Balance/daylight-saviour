---
status: accepted
---

# Manage Azure infrastructure with Bicep Deployment Stacks

All supporting Azure resources will be defined in Bicep and applied through subscription- or resource-group-scope Deployment Stacks. Deployments from the private operations repository will use GitHub Actions with workload identity federation, what-if validation, exact-commit verification, and least-privilege deployment identities; no Azure deployment credentials will be committed or stored as long-lived GitHub secrets.

The current GitHub plan does not provide protected private branches or protected deployment environments, and no paid-plan upgrade is planned for the foreseeable future. Every environment therefore uses a separate Azure deployment identity and federated identity credential bound to the exact trusted branch subject, environment-specific manual workflow dispatch, a reviewed what-if result for the same commit, and explicit confirmation before apply. Repository context and runbooks define the required operator procedure, recorded honestly as procedural controls rather than platform enforcement.

## Consequences

- Bicep validation and deployment-stack what-if run in CI before changes are applied.
- Environment-specific values remain parameters; secret values are provisioned through controlled data-plane operations rather than committed parameter files.
- Stack deny settings and unmanaged-resource behavior must be chosen explicitly before production deployment.
- A branch-bound federated credential must not be combined with a GitHub Environment on the deployment job because the environment changes the OIDC subject away from the branch reference.
- Apply is manual in every environment and must prove that the reviewed what-if and deployment use the same trusted-branch commit.
- Absence of branch or environment protection is an accepted procedural-control risk in every environment and must never be represented as platform enforcement.
- Production and non-production use separate least-privilege deployment identities, federated credentials, Azure scopes, workflows, confirmation text, and evidence. No identity may deploy across environments.
