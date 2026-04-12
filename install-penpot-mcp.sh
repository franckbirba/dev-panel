#!/bin/bash
set -e

# Penpot MCP Plugin Installer
# Installs the MCP plugin into a Penpot instance
# Compatible with Penpot 2.14.2
# Works with @penpot/mcp@2.14.1 (NOT @beta which is 2.15 and breaks)

PENPOT_VERSION="2.14.2"
MCP_VERSION="2.14.1"
PLUGIN_NAME="mcp"
PLUGIN_VERSION="2"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# Check if running in Docker context or local
if [ -z "$PENPOT_CONTAINER" ]; then
  PENPOT_CONTAINER="penpot-frontend"
  log_info "Using default container name: $PENPOT_CONTAINER"
fi

# Plugin source directory (where the plugin files are)
PLUGIN_SOURCE_DIR="${PLUGIN_SOURCE_DIR:-./penpot-mcp-plugin}"

# Verify container exists
if ! docker ps --format '{{.Names}}' | grep -q "$PENPOT_CONTAINER"; then
  log_error "Container $PENPOT_CONTAINER not found or not running"
  log_info "Available containers:"
  docker ps --format '{{.Names}}'
  exit 1
fi

# Check Penpot version
CURRENT_VERSION=$(docker image inspect penpotapp/frontend:latest --format='{{index .Config.Labels "version"}}' 2>/dev/null || echo "unknown")
log_info "Detected Penpot version: $CURRENT_VERSION"
if [ "$CURRENT_VERSION" != "$PENPOT_VERSION" ]; then
  log_warn "This script is tested with Penpot $PENPOT_VERSION, but you have $CURRENT_VERSION"
  read -p "Continue anyway? (y/N) " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    exit 1
  fi
fi

# Create plugin directory in container
log_info "Creating plugin directory in container..."
docker exec "$PENPOT_CONTAINER" mkdir -p "/var/www/app/plugins/$PLUGIN_NAME"

# Copy plugin files
log_info "Installing MCP plugin files..."

# Create manifest.json
log_info "Creating manifest.json..."
docker exec "$PENPOT_CONTAINER" sh -c "cat > /var/www/app/plugins/$PLUGIN_NAME/manifest.json" <<'EOF'
{
    "name": "Penpot MCP Plugin",
    "code": "plugin.js",
    "version": 2,
    "description": "This plugin enables interaction with the Penpot MCP server",
    "permissions": ["content:read", "content:write", "library:read", "library:write", "comment:read", "comment:write"]
}
EOF

# Extract and copy plugin.js from running container (as reference)
log_info "Extracting plugin code..."
docker exec "$PENPOT_CONTAINER" sh -c "cat > /var/www/app/plugins/$PLUGIN_NAME/plugin.js" <<'PLUGINEOF'
class m{constructor(e,t,s){this.requestId=e,this.taskType=t,this.params=s}isResponseSent=!1;sendResponse(e,t=void 0,s=void 0){if(this.isResponseSent){console.error("Response already sent for task:",this.requestId);return}const n={type:"task-response",response:{id:this.requestId,success:e,data:t,error:s}};penpot.ui.sendMessage(n),console.log("Sent task response:",n),this.isResponseSent=!0}sendSuccess(e=void 0){this.sendResponse(!0,e)}sendError(e){this.sendResponse(!1,void 0,e)}}class y{isApplicableTo(e){return this.taskType===e.taskType}}class f{static shapeStructure(e,t=void 0){let s;(t===void 0||t>0)&&"children"in e&&e.children&&(s=e.children.map(o=>this.shapeStructure(o,t===void 0?void 0:t-1)));const n={id:e.id,name:e.name,type:e.type};if("flex"in e&&e.flex){const o=e.flex;n.layout={type:"flex",dir:o.dir,rowGap:o.rowGap,columnGap:o.columnGap}}else if("grid"in e&&e.grid){const o=e.grid;n.layout={type:"grid",rows:o.rows,columns:o.columns,rowGap:o.rowGap,columnGap:o.columnGap}}if(e.isComponentInstance()){n.componentInstance={};const o=e.component();if(o){n.componentInstance.componentId=o.id,n.componentInstance.componentName=o.name;const r=o.mainInstance();r&&(n.componentInstance.mainInstanceId=r.id)}}return n.children=s,n}static findShapes(e,t=null){let s=new Array,n=function(o){if(o&&(e(o)&&s.push(o),"children"in o&&o.children))for(let r of o.children)n(r)};if(t===null){const o=penpot.currentFile?.pages;if(o)for(let r of o)n(r.root)}else n(t);return s}static findShape(e,t=null){let s=function(n){if(!n)return null;if(e(n))return n;if("children"in n&&n.children)for(let o of n.children){let r=s(o);if(r)return r}return null};if(t===null){const n=penpot.currentFile?.pages;if(n)for(let o of n){let r=s(o.root);if(r)return r}return null}else return s(t)}static findShapeById(e){return this.findShape(t=>t.id===e)}static findPage(e){return penpot.currentFile.pages.find(e)||null}static getPages(){return penpot.currentFile.pages.map(e=>({id:e.id,name:e.name}))}static getPageById(e){return this.findPage(t=>t.id===e)}static getPageByName(e){return this.findPage(t=>t.name.toLowerCase()===e.toLowerCase())}static getPageForShape(e){for(const t of penpot.currentFile.pages)if(t.getShapeById(e.id))return t;return null}static generateCss(e){const t=this.getPageForShape(e);if(!t)throw new Error("Shape is not part of any page");return penpot.openPage(t),penpot.generateStyle([e],{type:"css",includeChildren:!0})}static isContainedIn(e,t){return e.x>=t.x&&e.y>=t.y&&e.x+e.width<=t.x+t.width&&e.y+e.height<=t.y+t.height}static setParentXY(e,t,s){if(!e.parent)throw new Error("Shape has no parent - cannot set parent-relative position");e.x=e.parent.x+t,e.y=e.parent.y+s}static addFlexLayout(e,t){const n=("children"in e&&e.children?[...e.children]:[]).sort((r,i)=>t==="row"?r.x-i.x:r.y-i.y),o=e.addFlexLayout();o.dir=t;for(const r of n)r.setParentIndex(0);return o}static analyzeDescendants(e,t,s=void 0){const n=[],o=(r,i)=>{const p=t(e,r);if(p!=null&&n.push({shape:r,result:p}),(s===void 0||i<s)&&"children"in r&&r.children)for(const c of r.children)o(c,i+1)};if("children"in e&&e.children)for(const r of e.children)o(r,1);return n}static atob(e){const t="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/",s=new Uint8Array(256);for(let i=0;i<t.length;i++)s[t.charCodeAt(i)]=i;let n=e.length*.75;e[e.length-1]==="="&&(n--,e[e.length-2]==="="&&n--);const o=new Uint8Array(n);let r=0;for(let i=0;i<e.length;i+=4){const p=s[e.charCodeAt(i)],c=s[e.charCodeAt(i+1)],l=s[e.charCodeAt(i+2)],d=s[e.charCodeAt(i+3)];o[r++]=p<<2|c>>4,o[r++]=(c&15)<<4|l>>2,o[r++]=(l&3)<<6|d&63}return o}static async importImage(e,t,s,n,o,r,i){const p=f.atob(e),c=await penpot.uploadMediaData(s,p,t),l=penpot.createRectangle();l.name=s;let d,u;const g=r!==void 0,h=i!==void 0;return g&&h?(d=r,u=i):g?(d=r,u=d*(c.height/c.width)):h?(u=i,d=u*(c.width/c.height)):(d=c.width,u=c.height),l.resize(d,u),n!==void 0&&(l.x=n),o!==void 0&&(l.y=o),l.fills=[{fillOpacity:1,fillImage:c}],l}static async exportImage(e,t,s){switch(t){case"shape":return e.export({type:s?"svg":"png"});case"fill":if(s)throw new Error("Image fills cannot be exported as SVG");if(!("fills"in e))throw new Error("Shape with `fills` member is required for fill export mode");const n=e.fills;for(const o of n)if(o.fillImage)return o.fillImage.data();throw new Error("No fill with image data found in the shape");default:throw new Error(`Unsupported export mode: ${t}`)}}static findTokensByName(e){const t=[],s=penpot.library.local.tokens;for(const n of s.sets)for(const o of n.tokens)o.name===e&&t.push(o);return t}static findTokenByName(e){const t=penpot.library.local.tokens;for(const s of t.sets)for(const n of s.tokens)if(n.name===e)return n;return null}static getTokenSet(e){const t=penpot.library.local.tokens;for(const s of t.sets)if(s.tokens.includes(e))return s;return null}static tokenOverview(){const e={},t=penpot.library.local.tokens;for(const s of t.sets){const n={};for(const o of s.tokens){const r=o.type;n[r]||(n[r]=[]),n[r].push(o.name)}e[s.name]=n}return e}}class k{logOutput="";resetLog(){this.logOutput=""}getLog(){return this.logOutput}appendToLog(e,...t){const s=t.map(n=>typeof n=="object"?JSON.stringify(n,null,2):String(n)).join(" ");this.logOutput+=`[${e}] ${s}
`}log(...e){this.appendToLog("LOG",...e)}warn(...e){this.appendToLog("WARN",...e)}error(...e){this.appendToLog("ERROR",...e)}info(...e){this.appendToLog("INFO",...e)}debug(...e){this.appendToLog("DEBUG",...e)}trace(...e){this.appendToLog("TRACE",...e)}table(e){this.appendToLog("TABLE",e)}time(e){this.appendToLog("TIME",`Timer started: ${e||"default"}`)}timeEnd(e){this.appendToLog("TIME_END",`Timer ended: ${e||"default"}`)}group(e){this.appendToLog("GROUP",e||"")}groupCollapsed(e){this.appendToLog("GROUP_COLLAPSED",e||"")}groupEnd(){this.appendToLog("GROUP_END","")}clear(){}count(e){this.appendToLog("COUNT",e||"default")}countReset(e){this.appendToLog("COUNT_RESET",e||"default")}assert(e,...t){e||this.appendToLog("ASSERT",...t)}}class w extends y{taskType="executeCode";context;constructor(){super(),this.context={penpot,storage:{},console:new k,penpotUtils:f}}async handle(e){if(!e.params.code){e.sendError("executeCode task requires 'code' parameter");return}this.context.console.resetLog();const t=this.context,s=e.params.code;let n=await(async r=>new Function(...Object.keys(r),`return (async () => { ${s} })();`)(...Object.values(r)))(t);console.log("Code execution result:",n);let o={result:n,log:this.context.console.getLog()};e.sendSuccess(o)}}const T=[new w],E=!0;penpot.ui.open("Penpot MCP Plugin",`?theme=${penpot.theme}&multiUser=${E}`,{width:158,height:200});penpot.ui.onMessage(a=>{typeof a=="object"&&a.task&&a.id&&x(a).catch(e=>{console.error("Error in handlePluginTaskRequest:",e)})});async function x(a){console.log("Executing plugin task:",a.task,a.params);const e=new m(a.id,a.task,a.params),t=T.find(s=>s.isApplicableTo(e));if(t)try{console.log("Processing task with handler:",t),await t.handle(e),e.isResponseSent||(console.warn("Handler did not send a response, sending generic success."),e.sendSuccess("Task completed without a specific response.")),console.log("Task handled successfully:",e)}catch(s){console.error("Error handling task:",s);const n=s instanceof Error?s.message:"Unknown error";e.sendError(`Error handling task: ${n}`)}else console.error("Unknown plugin task:",a.task),e.sendError(`Unknown task type: ${a.task}`)}penpot.on("themechange",a=>{penpot.ui.sendMessage({source:"penpot",type:"themechange",theme:a})});
PLUGINEOF

# Create index.html for plugin UI
log_info "Creating plugin UI (index.html)..."
docker exec "$PENPOT_CONTAINER" sh -c "cat > /var/www/app/plugins/$PLUGIN_NAME/index.html" <<'HTMLEOF'
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Penpot MCP Plugin</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            font-size: 12px;
            padding: 8px;
            background: var(--bg, #1a1a1a);
            color: var(--text, #fff);
        }
        body[data-theme="light"] {
            --bg: #f5f5f5;
            --text: #000;
        }
        .status {
            padding: 6px;
            border-radius: 4px;
            background: #2a2a2a;
            text-align: center;
            font-weight: 500;
        }
        .connected { background: #1a472a; color: #4ade80; }
        .info { margin-top: 8px; font-size: 11px; opacity: 0.7; }
    </style>
</head>
<body>
    <div class="status connected">✓ MCP Connected</div>
    <div class="info">Ready for Claude Code</div>
</body>
</html>
HTMLEOF

# Verify installation
log_info "Verifying installation..."
if docker exec "$PENPOT_CONTAINER" test -f "/var/www/app/plugins/$PLUGIN_NAME/manifest.json"; then
  log_info "✓ Plugin manifest installed"
else
  log_error "✗ Plugin manifest NOT found"
  exit 1
fi

if docker exec "$PENPOT_CONTAINER" test -f "/var/www/app/plugins/$PLUGIN_NAME/plugin.js"; then
  log_info "✓ Plugin code installed"
else
  log_error "✗ Plugin code NOT found"
  exit 1
fi

# Set proper permissions
log_info "Setting permissions..."
docker exec "$PENPOT_CONTAINER" chown -R penpot:root "/var/www/app/plugins/$PLUGIN_NAME"
docker exec "$PENPOT_CONTAINER" chmod -R 755 "/var/www/app/plugins/$PLUGIN_NAME"

log_info "${GREEN}✓ MCP Plugin installed successfully!${NC}"
log_info ""
log_info "Plugin location: /var/www/app/plugins/$PLUGIN_NAME"
log_info "Plugin version: $PLUGIN_VERSION"
log_info "Penpot version: $CURRENT_VERSION"
log_info "Compatible MCP server: @penpot/mcp@$MCP_VERSION"
log_info ""
log_info "Next steps:"
log_info "1. Restart Penpot: docker restart $PENPOT_CONTAINER"
log_info "2. Start MCP server: npx @penpot/mcp@$MCP_VERSION"
log_info "   ${YELLOW}⚠️  DO NOT use @beta (2.15) - it breaks compatibility${NC}"
log_info "3. Configure Claude MCP:"
log_info "   claude mcp add"
log_info "   → Name: penpot"
log_info "   → Transport: http"
log_info "   → URL: http://localhost:4401/mcp"
log_info "4. Open Penpot and activate the MCP plugin in Plugins menu"
log_info ""
log_info "${YELLOW}Known issue:${NC} Pages share elements → work on single page with spaced frames"
