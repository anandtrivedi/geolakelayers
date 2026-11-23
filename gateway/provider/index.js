/*
  Derived from koop-provider-databricks, which is based on a Koop provider originally published by Esri
  (Copyright 2020 Esri; Apache License, Version 2.0, see licenses/Apache-2.0.txt). Modified by Databricks.
*/
/*
  index.js

  This file is required. It's role is to specify configuration settings.

  Documentation: http://koopjs.github.io/docs/usage/provider
*/

require('dotenv').config()
// Define the provider path
// /:name/:hosts?/:disableIdParam?/FeatureServer/:layer/:method
// e.g. /example/FeatureServer/0/query
const provider = {
  type: 'provider',
  name: 'databricks',
  hosts: false, // if true, also adds disableIdParam
  disableIdParam: false, // if true, adds to path and req.params
  Controller: require('./controller'),
  Model: require('./model'),
  routes: require('./routes'),
  version: require('../package.json').version
}

module.exports = provider
