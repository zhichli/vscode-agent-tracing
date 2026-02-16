targetScope = 'resourceGroup'

@description('Azure region — defaults to resource group location')
param location string = resourceGroup().location

// ─── Modules ────────────────────────────────────────────────────────────────

module appInsights 'modules/appinsights.bicep' = {
  name: 'appinsights'
  params: {
    location: location
  }
}

// ─── Outputs ────────────────────────────────────────────────────────────────

@description('Application Insights connection string (add to GitHub secrets as APPINSIGHTS_CONNECTION_STRING)')
output appInsightsConnectionString string = appInsights.outputs.connectionString

@description('Application Insights instrumentation key')
output appInsightsInstrumentationKey string = appInsights.outputs.instrumentationKey
