import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const compiledTemplatePath = new URL(
  './minimal-functions-platform.generated.json',
  import.meta.url,
);
const compiledTemplate = JSON.parse(readFileSync(compiledTemplatePath, 'utf8'));

function resourcesOfType(type) {
  const matches = [];

  function visit(value) {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }

    if (value === null || typeof value !== 'object') {
      return;
    }

    if (value.type === type && typeof value.apiVersion === 'string') {
      matches.push(value);
    }

    Object.values(value).forEach(visit);
  }

  visit(compiledTemplate);
  return matches;
}

function oneResource(type) {
  const resources = resourcesOfType(type);
  assert.equal(resources.length, 1, `expected one ${type} resource`);
  return resources[0];
}

describe('minimal Functions platform Bicep module', () => {
  it('keeps one small environment-independent interface', () => {
    assert.deepEqual(Object.keys(compiledTemplate.parameters).sort(), [
      'buildVersion',
      'location',
      'resourceNames',
      'runtime',
      'scale',
      'security',
      'tags',
    ]);

    assert.deepEqual(
      compiledTemplate.definitions.RuntimeSettings.properties.name
        .allowedValues,
      ['node'],
    );
    assert.deepEqual(
      compiledTemplate.definitions.RuntimeSettings.properties.version
        .allowedValues,
      ['22', '24'],
    );
    assert.deepEqual(
      [
        ...compiledTemplate.definitions.ScaleSettings.properties
          .instanceMemoryMB.allowedValues,
      ].sort((left, right) => left - right),
      [512, 2048, 4096],
    );
    assert.equal(
      compiledTemplate.definitions.ScaleSettings.properties.maximumInstanceCount
        .minValue,
      1,
    );
  });

  it('enforces Azure naming length limits at the interface', () => {
    const names = compiledTemplate.definitions.PlatformResourceNames.properties;

    assert.deepEqual(
      Object.fromEntries(
        Object.entries(names).map(([name, definition]) => [
          name,
          [definition.minLength, definition.maxLength],
        ]),
      ),
      {
        applicationInsights: [1, 260],
        deploymentContainer: [3, 63],
        functionApp: [2, 60],
        functionPlan: [1, 60],
        keyVault: [3, 24],
        logAnalyticsWorkspace: [4, 63],
        runtimeIdentity: [3, 128],
        storageAccount: [3, 24],
      },
    );
    assert.equal(
      compiledTemplate.definitions.PlatformResourceNames.additionalProperties,
      false,
    );
  });

  it('uses managed identity for Functions host and package storage', () => {
    const functionApp = oneResource('Microsoft.Web/sites');
    const appSettings = oneResource('Microsoft.Web/sites/config');
    const deploymentStorage =
      functionApp.properties.functionAppConfig.deployment.storage;

    assert.equal(functionApp.identity.type, 'UserAssigned');
    assert.equal(deploymentStorage.type, 'blobContainer');
    assert.equal(deploymentStorage.authentication.type, 'UserAssignedIdentity');
    assert.equal(
      appSettings.properties.AzureWebJobsStorage__credential,
      'managedidentity',
    );
    assert.ok(appSettings.properties.AzureWebJobsStorage__clientId);
    assert.equal(appSettings.properties.FUNCTIONS_EXTENSION_VERSION, '~4');
    assert.ok(appSettings.properties.KEY_VAULT_URI);
    assert.equal(
      appSettings.properties.BUILD_VERSION,
      "[parameters('buildVersion')]",
    );
  });

  it('configures runtime through Flex metadata without legacy worker setting', () => {
    const functionPlan = oneResource('Microsoft.Web/serverfarms');
    const functionApp = oneResource('Microsoft.Web/sites');
    const appSettings = oneResource('Microsoft.Web/sites/config').properties;

    assert.deepEqual(functionPlan.sku, {
      name: 'FC1',
      tier: 'FlexConsumption',
    });
    assert.deepEqual(functionApp.properties.functionAppConfig.runtime, {
      name: "[parameters('runtimeName')]",
      version: "[parameters('runtimeVersion')]",
    });
    assert.equal(Object.hasOwn(appSettings, 'FUNCTIONS_WORKER_RUNTIME'), false);
    assert.equal(
      appSettings.AzureWebJobsStorage__accountName,
      "[parameters('storageAccountName')]",
    );
    assert.equal(
      appSettings.AzureWebJobsStorage__clientId,
      "[parameters('runtimeIdentityClientId')]",
    );
    assert.equal(
      appSettings.AzureWebJobsStorage__credential,
      'managedidentity',
    );
    assert.equal(appSettings.KEY_VAULT_URI, "[parameters('keyVaultUri')]");
    assert.equal(appSettings.BUILD_VERSION, "[parameters('buildVersion')]");
  });

  it('denies shared-key, public-blob, and basic publishing access', () => {
    const storage = oneResource('Microsoft.Storage/storageAccounts');
    const deploymentContainer = oneResource(
      'Microsoft.Storage/storageAccounts/blobServices/containers',
    );
    const functionApp = oneResource('Microsoft.Web/sites');
    const publishingPolicies = resourcesOfType(
      'Microsoft.Web/sites/basicPublishingCredentialsPolicies',
    );

    assert.equal(storage.properties.allowBlobPublicAccess, false);
    assert.equal(storage.properties.allowSharedKeyAccess, false);
    assert.equal(storage.properties.defaultToOAuthAuthentication, true);
    assert.equal(storage.properties.minimumTlsVersion, 'TLS1_2');
    assert.equal(storage.properties.supportsHttpsTrafficOnly, true);
    assert.equal(deploymentContainer.properties.publicAccess, 'None');
    assert.equal(functionApp.properties.httpsOnly, true);
    assert.equal(functionApp.properties.siteConfig.ftpsState, 'Disabled');
    assert.equal(functionApp.properties.siteConfig.minTlsVersion, '1.2');
    assert.equal(publishingPolicies.length, 2);
    assert.ok(
      publishingPolicies.every((policy) => policy.properties.allow === false),
    );
  });

  it('enables Key Vault RBAC and irreversible recovery protection', () => {
    const vault = oneResource('Microsoft.KeyVault/vaults');

    assert.deepEqual(vault.properties.accessPolicies, []);
    assert.equal(vault.properties.enablePurgeProtection, true);
    assert.equal(vault.properties.enableRbacAuthorization, true);
    assert.equal(vault.properties.enableSoftDelete, true);
  });

  it('grants only current runtime data-plane roles', () => {
    const templateText = JSON.stringify(compiledTemplate);
    const expectedRoleIds = [
      '0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3',
      '3913510d-42f4-4e42-8a64-420c390055eb',
      '4633458b-17de-408a-b874-0445c86b69e6',
      'b7e6dc6d-f1e8-4753-8033-0f276bb0955b',
    ];

    assert.equal(
      resourcesOfType('Microsoft.Authorization/roleAssignments').length,
      4,
    );
    expectedRoleIds.forEach((roleId) =>
      assert.match(templateText, new RegExp(roleId)),
    );
    assert.doesNotMatch(templateText, /974c5e8b-45b9-4653-ba55-5f855dd0fb88/);
  });

  it('derives deterministic role-assignment names without runtime identity lookup', () => {
    const authorizationDeployment = resourcesOfType(
      'Microsoft.Resources/deployments',
    ).find(
      (deployment) => deployment.name === 'notification-platform-authorization',
    );
    assert.ok(authorizationDeployment);

    const identityResourceId =
      authorizationDeployment.properties.parameters.runtimeIdentityResourceId
        .value;
    assert.equal(
      identityResourceId,
      "[variables('runtimeIdentityResourceId')]",
    );
    assert.equal(
      compiledTemplate.variables.runtimeIdentityResourceId,
      "[resourceId('Microsoft.ManagedIdentity/userAssignedIdentities', parameters('resourceNames').runtimeIdentity)]",
    );
    assert.doesNotMatch(identityResourceId, /reference|list/i);
    assert.doesNotMatch(
      compiledTemplate.variables.runtimeIdentityResourceId,
      /reference|list/i,
    );

    const roleAssignments = resourcesOfType(
      'Microsoft.Authorization/roleAssignments',
    );
    for (const roleAssignment of roleAssignments) {
      assert.match(roleAssignment.name, /^\[guid\(/);
      assert.match(
        roleAssignment.name,
        /parameters\('runtimeIdentityResourceId'\)/,
      );
      assert.doesNotMatch(roleAssignment.name, /reference|list/i);
      assert.equal(
        roleAssignment.properties.principalId,
        "[parameters('runtimePrincipalId')]",
      );

      const roleVariableMatch =
        roleAssignment.properties.roleDefinitionId.match(
          /variables\('([^']+RoleId)'\)/,
        );
      assert.ok(roleVariableMatch);
      assert.match(
        roleAssignment.name,
        new RegExp(`variables\\('${roleVariableMatch[1]}'\\)`),
      );
    }
  });

  it('routes supported platform diagnostics to Log Analytics', () => {
    const diagnostics = resourcesOfType(
      'Microsoft.Insights/diagnosticSettings',
    );

    assert.equal(diagnostics.length, 3);
    assert.ok(
      diagnostics.every(
        (diagnostic) => typeof diagnostic.properties.workspaceId === 'string',
      ),
    );
  });
});
