import type { GatewayInfo } from '../api'
import { Copy, CopyToken, UrlField } from './Copy'
import { OriginCheck } from './OriginCheck'

// Everything an ArcGIS author or admin pastes somewhere else: the widget path first, the Custom Data Feed
// for Map Viewer / Pro, then FeatureServer REST for scripts
export function ArcGIS ({ info, table, onHelp, onInstall }: { info: GatewayInfo, table?: string, onHelp: () => void, onInstall: () => void }) {
  const example = table || '<catalog>.<schema>.<table>'
  const layerUrl = `${info.gatewayUrl}/databricks/rest/services/${example}/FeatureServer/0`
  const host = info.workspaceHost ? `https://${info.workspaceHost}` : '<workspace URL>'
  const snippet = [
    '# A Databricks OAuth token for you (or a service principal); personal access tokens are not accepted',
    `TOKEN=$(databricks auth token --host ${host} | jq -r .access_token)`,
    '',
    `curl -H "Authorization: Bearer $TOKEN" "${layerUrl}/query?where=1%3D1&outFields=*&resultRecordCount=10&f=json"`
  ].join('\n')
  return (
    <>
      <section className='card'>
        <div className='muted small'>ArcGIS · Experience Builder</div>
        <h2>Use these tables in Experience Builder</h2>
        <p className='muted lead'>
          The Databricks Data widget adds Unity Catalog tables to an Experience Builder map. Each viewer signs in with
          Databricks, so they see only what Unity Catalog lets them see.
        </p>
        <ol className='use-steps arcgis-steps'>
          <li>
            <b>An ArcGIS admin adds the widget to Experience Builder, once.</b>{' '}
            {info.widgetSource ? <><a href={info.widgetSource} target='_blank' rel='noreferrer'>Get the widget</a>.</> : 'Ask the person who deployed this gateway for it.'}{' '}
            Its Portal or Experience Builder address must be allowed to call this gateway; check it below.{' '}
            <button className='link' onClick={onInstall}>Install steps, with screenshots</button>
          </li>
          <li>
            <b>Add the widget to your app, next to the map, and give it this gateway URL:</b>
            <UrlField url={info.gatewayUrl} label='Gateway URL' copyLabel='Copy gateway URL' primary />
          </li>
          <li><b>Sign in, then pick tables</b> as start-up layers, or let viewers add them. Other widgets (Table, Filter, Chart) connect to them like any layer.</li>
        </ol>
        <p className='caveat small'>
          ArcGIS Map Viewer and ArcGIS Pro can't add these layers by URL: "add layer from URL" doesn't send a Databricks
          sign-in. <button className='link' onClick={onHelp}>The guide</button> covers every client.
        </p>
        {info.cdfSource && (
          <div className='callout'>
            <p className='callout-title'>
              Need these layers in Map Viewer, ArcGIS Pro or Field Maps?{' '}
              <a href={info.cdfSource} target='_blank' rel='noreferrer'>Publish them as ArcGIS Server feature services with the Databricks Custom Data Feed →</a>
            </p>
            <p className='small muted'>Runs inside ArcGIS Enterprise 11.4+; access is set by Portal sharing.</p>
            <table className='guide-table compare'>
              <thead><tr><th /><th>This gateway</th><th>Custom Data Feed</th></tr></thead>
              <tbody>
                <tr><td>Runs in</td><td>Databricks (this app); nothing installed in ArcGIS</td><td>ArcGIS Server 11.4+ with the Custom Data Feeds runtime</td></tr>
                <tr><td>ArcGIS apps</td><td>Experience Builder (widget), ArcGIS Maps SDK apps and scripts</td><td>Map Viewer, ArcGIS Pro, Field Maps and other apps that use feature services</td></tr>
                <tr><td>Who sees what</td><td>Unity Catalog grants, per viewer</td><td>Portal sharing; Databricks is read with one service principal or token</td></tr>
                <tr><td>Also serves</td><td>OGC API – Features (QGIS, GDAL, web maps)</td><td>ArcGIS feature services</td></tr>
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className='card'>
        <h2>Can this Experience Builder call the gateway?</h2>
        <p className='muted small'>
          Only allowed Portal and Experience Builder addresses get a sign-in. Paste the address of the app or builder.
        </p>
        <OriginCheck allowedOrigins={info.allowedOrigins} />
      </section>

      <details className='card fold'>
        <summary><b>Scripts and notebooks</b> <span className='muted small'>Esri FeatureServer REST</span></summary>
        <p className='small'>
          Each table is a FeatureServer layer. Send a Databricks OAuth token as <code>Authorization: Bearer</code>;
          personal access tokens aren't accepted. <CopyToken />
        </p>
        <UrlField url={layerUrl} label='Layer URL' copyLabel='Copy layer URL' />
        <div className='snippet-wrap'>
          <pre className='snippet'>{snippet}</pre>
          <Copy text={snippet} />
        </div>
      </details>
    </>
  )
}
