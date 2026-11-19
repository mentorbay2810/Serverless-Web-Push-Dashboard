targetScope = 'resourceGroup'

@description('One region shared by the demonstration resources.')
param location string = resourceGroup().location
param webOrigin string = 'http://localhost:5173'
param tenantId string
param apiClientId string
param spaClientId string
param administratorObjectId string
@minValue(1)
@maxValue(1000)
@description('Per-function scale-group ceiling. This is an application limit, not a currency cap.')
param maximumInstanceCount int = 1
@minValue(1)
@maxValue(100)
param maximumSubscriptions int = 100
@minValue(1)
@maxValue(1000)
param dailyAttemptLimit int = 1000
@secure()
param vapidPrivateKey string
param vapidPublicKey string
param vapidSubject string

var suffix = uniqueString(resourceGroup().id)
var storageName = 'wp${suffix}'
var functionName = 'webpush-${suffix}'
var tags = { project: 'serverless-web-push', environment: 'dissertation-demo' }

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageName
  location: location
  tags: tags
  sku: { name: 'Standard_LRS' }
  kind: 'StorageV2'
  properties: {
    accessTier: 'Hot'
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
  }
}
resource blob 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storage
  name: 'default'
}
resource packages 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blob
  name: 'function-packages'
  properties: { publicAccess: 'None' }
}
resource bus 'Microsoft.ServiceBus/namespaces@2024-01-01' = {
  name: 'webpush-${suffix}'
  location: location
  tags: tags
  sku: { name: 'Basic', tier: 'Basic' }
  properties: { minimumTlsVersion: '1.2', disableLocalAuth: true, publicNetworkAccess: 'Enabled' }
}
resource queues 'Microsoft.ServiceBus/namespaces/queues@2024-01-01' = [for name in ['campaigns', 'deliveries']: {
  parent: bus
  name: name
  properties: {
    lockDuration: 'PT1M'
    maxDeliveryCount: 5
    defaultMessageTimeToLive: 'PT1H'
    deadLetteringOnMessageExpiration: true
    enableBatchedOperations: true
    maxSizeInMegabytes: 1024
    requiresDuplicateDetection: false
    requiresSession: false
  }
}]
resource cosmos 'Microsoft.DocumentDB/databaseAccounts@2024-11-15' = {
  name: 'webpush-${suffix}'
  location: location
  tags: tags
  kind: 'GlobalDocumentDB'
  properties: {
    databaseAccountOfferType: 'Standard'
    enableFreeTier: true
    disableLocalAuth: true
    enableAutomaticFailover: false
    enableMultipleWriteLocations: false
    consistencyPolicy: { defaultConsistencyLevel: 'Session' }
    locations: [{ locationName: location, failoverPriority: 0, isZoneRedundant: false }]
    capacity: { totalThroughputLimit: 1000 }
  }
}
resource database 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases@2024-11-15' = {
  parent: cosmos
  name: 'webpush'
  properties: { resource: { id: 'webpush' }, options: { throughput: 400 } }
}
resource documents 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-11-15' = {
  parent: database
  name: 'documents'
  properties: {
    resource: {
      id: 'documents'
      partitionKey: { paths: ['/siteId'], kind: 'Hash', version: 2 }
      defaultTtl: -1
      indexingPolicy: {
        automatic: true
        indexingMode: 'consistent'
        includedPaths: [
          { path: '/kind/?' }
          { path: '/state/?' }
          { path: '/nextAttemptAt/?' }
          { path: '/leaseUntil/?' }
          { path: '/campaignId/?' }
        ]
        excludedPaths: [{ path: '/*' }]
      }
    }
  }
}
resource plan 'Microsoft.Web/serverfarms@2024-04-01' = {
  name: 'webpush-${suffix}'
  location: location
  tags: tags
  kind: 'functionapp'
  sku: { name: 'FC1', tier: 'FlexConsumption' }
  properties: { reserved: true }
}
resource functions 'Microsoft.Web/sites@2024-04-01' = {
  name: functionName
  location: location
  tags: tags
  kind: 'functionapp,linux'
  identity: { type: 'SystemAssigned' }
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    publicNetworkAccess: 'Enabled'
    functionAppConfig: {
      runtime: { name: 'node', version: '24' }
      deployment: { storage: {
        type: 'blobContainer'
        value: '${storage.properties.primaryEndpoints.blob}${packages.name}'
        authentication: { type: 'SystemAssignedIdentity' }
      } }
      scaleAndConcurrency: {
        maximumInstanceCount: maximumInstanceCount
        instanceMemoryMB: 512
        alwaysReady: []
        triggers: { http: { perInstanceConcurrency: 4 } }
      }
    }
    siteConfig: {
      minTlsVersion: '1.2'
      ftpsState: 'Disabled'
      cors: { allowedOrigins: [webOrigin], supportCredentials: false }
      appSettings: [
        { name: 'AzureWebJobsStorage__credential', value: 'managedidentity' }
        { name: 'AzureWebJobsStorage__blobServiceUri', value: storage.properties.primaryEndpoints.blob }
        { name: 'AzureWebJobsStorage__queueServiceUri', value: storage.properties.primaryEndpoints.queue }
        { name: 'AzureWebJobsStorage__tableServiceUri', value: storage.properties.primaryEndpoints.table }
        { name: 'SITE_ID', value: 'dissertation-demo' }
        { name: 'WEB_ORIGIN', value: webOrigin }
        { name: 'COSMOS_ENDPOINT', value: cosmos.properties.documentEndpoint }
        { name: 'COSMOS_DATABASE', value: database.name }
        { name: 'COSMOS_CONTAINER', value: documents.name }
        { name: 'SERVICEBUS_NAMESPACE', value: '${bus.name}.servicebus.windows.net' }
        { name: 'ServiceBusConnection__fullyQualifiedNamespace', value: '${bus.name}.servicebus.windows.net' }
        { name: 'ServiceBusConnection__credential', value: 'managedidentity' }
        { name: 'CAMPAIGN_QUEUE', value: 'campaigns' }
        { name: 'DELIVERY_QUEUE', value: 'deliveries' }
        { name: 'ENTRA_TENANT_ID', value: tenantId }
        { name: 'ENTRA_API_CLIENT_ID', value: apiClientId }
        { name: 'ENTRA_SPA_CLIENT_ID', value: spaClientId }
        { name: 'ADMIN_OBJECT_IDS', value: administratorObjectId }
        { name: 'MAX_SUBSCRIPTIONS', value: string(maximumSubscriptions) }
        { name: 'DAILY_ATTEMPT_LIMIT', value: string(dailyAttemptLimit) }
        { name: 'VAPID_PUBLIC_KEY', value: vapidPublicKey }
        { name: 'VAPID_PRIVATE_KEY', value: vapidPrivateKey }
        { name: 'VAPID_SUBJECT', value: vapidSubject }
      ]
    }
  }
}
resource blobRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storage.id, functions.id, 'blob-owner')
  scope: storage
  properties: {
    principalId: functions.identity.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'b7e6dc6d-f1e8-4753-8033-0f276bb0955b')
  }
}
resource busRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(bus.id, functions.id, 'bus-owner')
  scope: bus
  properties: {
    principalId: functions.identity.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '090c5cfd-751d-490a-894a-3ce6f1109419')
  }
}
resource cosmosRole 'Microsoft.DocumentDB/databaseAccounts/sqlRoleAssignments@2024-11-15' = {
  parent: cosmos
  name: guid(cosmos.id, functions.id, 'cosmos-contributor')
  properties: {
    principalId: functions.identity.principalId
    roleDefinitionId: '${cosmos.id}/sqlRoleDefinitions/00000000-0000-0000-0000-000000000002'
    scope: cosmos.id
  }
}

output functionName string = functions.name
output apiOrigin string = 'https://${functions.properties.defaultHostName}'
output cosmosAccount string = cosmos.name
output serviceBusNamespace string = bus.name
output storageAccount string = storage.name
