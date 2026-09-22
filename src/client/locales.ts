/**
 * Locale bundles for the Playwright card (the plugin's own dictionary
 * namespace, registered with the client locale service).
 *
 * @module dsh-web-fetch-playwright/client/locales
 */

/** Locale keys this card renders. */
export type PlaywrightCardLocaleKey =
  | 'title' | 'description'
  | 'backendLabel' | 'backendLocal' | 'backendLocalHint' | 'backendCdp' | 'backendCdpHint'
  | 'backendManaged' | 'backendManagedHint'
  | 'playwrightPath' | 'playwrightPathHint' | 'playwrightPathPlaceholder'
  | 'cdpEndpoint' | 'cdpEndpointHint'
  | 'shareBrowserContext' | 'shareBrowserContextHint'
  | 'headless' | 'headlessHint'
  | 'userDataDir' | 'userDataDirHint' | 'userDataDirPlaceholder'
  | 'launchArgs' | 'launchArgsHint' | 'launchArgsPlaceholder'
  | 'launcherPreview' | 'launcherPreviewHint'
  | 'recordNetwork' | 'recordNetworkHint'
  | 'recordDir' | 'recordDirHint' | 'recordDirPlaceholder'
  | 'captureBodies' | 'captureBodiesHint'
  | 'maxBodyBytes' | 'maxBodyBytesHint' | 'maxBodyBytesPlaceholder'
  | 'recordAllResources' | 'recordAllResourcesHint'
  | 'recordWarning'
  | 'denoise' | 'denoiseHint'
  | 'maxConcurrency' | 'maxConcurrencyHint' | 'maxConcurrencyPlaceholder'
  | 'challengeWaitMs' | 'challengeWaitMsHint' | 'challengeWaitMsPlaceholder'
  | 'proxyServer' | 'proxyServerHint' | 'proxyServerPlaceholder'
  | 'proxyBypass' | 'proxyBypassHint' | 'proxyBypassPlaceholder'
  | 'proxyUsername' | 'proxyUsernameHint'
  | 'proxyPassword' | 'proxyPasswordHint'
  | 'overridden' | 'reset' | 'readOnly' | 'expand' | 'collapse'
  | 'save' | 'saving' | 'discard' | 'unsaved' | 'saveFailed' | 'invalidText'

/** This plugin's dictionary namespace, merged into the locale key map. */
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'web-fetch-playwright': PlaywrightCardLocaleKey
  }
}

/** English copy. */
export const en: Record<PlaywrightCardLocaleKey, string> = {
  title: 'Playwright web fetch',
  description: 'Fetches pages with a real browser (local Playwright or CDP) and returns denoised markdown.',
  backendLabel: 'Playwright backend',
  backendLocal: 'Local Playwright',
  backendLocalHint: 'Launch a throwaway browser through the local playwright installation — one browser per fetch, nothing kept.',
  backendCdp: 'Remote CDP endpoint',
  backendCdpHint: 'Drive an already-running browser over its DevTools Protocol port. A proxy for that browser must have been set when it started (--proxy-server=...): this plugin cannot inject a proxy into (or verify one on) an already-running browser, and does not block such fetches — the launcher below builds that command for you.',
  backendManaged: 'DSH-managed persistent browser',
  backendManagedHint: 'DSH launches ONE browser on a persistent user-data-dir and reuses it for every fetch as tabs: logins persist across fetches and restarts, and the proxy really applies. Close it by unloading the plugin or changing a launch setting.',
  playwrightPath: 'Playwright executable path',
  playwrightPathHint: 'Leave blank to find playwright on $PATH; a browser executable path also works.',
  playwrightPathPlaceholder: '(auto: playwright from $PATH)',
  cdpEndpoint: 'CDP endpoint',
  cdpEndpointHint: 'host:port or http(s)/ws URL. Leave blank for 127.0.0.1:9222.',
  shareBrowserContext: 'Share the browser context (profile logins)',
  shareBrowserContextHint: 'Each fetch opens a tab in the remote browser\u2019s real profile \u2014 cookies and localStorage are shared and its persistent logins apply. Unchecked: every fetch uses a fresh isolated context.',
  headless: 'Run headless',
  headlessHint: 'Checked: no window (a server has no display). Unchecked: headful \u2014 useful with a desktop session for logging in by hand.',
  userDataDir: 'Persistent profile directory (user-data-dir)',
  userDataDirHint: 'Where the managed browser keeps its profile \u2014 logins, cookies, extensions. Blank = $DSH_HOME/web-fetch-playwright/profile. Treat this directory as credential-bearing; it is never cleaned.',
  userDataDirPlaceholder: '(default: $DSH_HOME/web-fetch-playwright/profile)',
  launchArgs: 'Extra browser arguments',
  launchArgsHint: 'Appended to every browser this plugin launches (and to the launcher command), e.g. --lang=zh-CN --disable-gpu. Split on spaces; use quotes for a value with spaces.',
  launchArgsPlaceholder: '--lang=zh-CN --disable-gpu',
  launcherPreview: 'Local launcher command (read-only)',
  launcherPreviewHint: 'What `dsh-web-fetch-launch` would run for the CDP/tunnel topology: your browser on a COPY of the real profile, this proxy, a loopback DevTools port. Run it with --dry-run to print without starting; `autossh -M 0 -N -R 9222:127.0.0.1:9222 <user@server>` carries that port to the plugin host.',
  recordNetwork: 'Record network traffic (XHR/Fetch/WebSocket)',
  recordNetworkHint: 'One CDP session on the tab each fetch opens: request URL/method/headers/payload, response status/headers/body, and WebSocket frames, appended as JSONL while the fetch runs plus a HAR 1.2 export when it ends. Only this plugin\u2019s own fetches are recorded \u2014 never other tabs. Off by default.',
  recordDir: 'Dump directory',
  recordDirHint: 'Base directory; each capture gets its own <session> subdirectory. Blank = <working directory>/net-dumps (gitignored), mode 0700, files 0600.',
  recordDirPlaceholder: '(default: <cwd>/net-dumps)',
  captureBodies: 'Capture response bodies',
  captureBodiesHint: 'Read each response body through CDP, bounded by the byte cap below. Off = URLs, status, headers, and payloads only.',
  maxBodyBytes: 'Max body bytes',
  maxBodyBytesHint: 'Byte cap per stored response body / WebSocket frame (0\u201316 MiB). A cut body is flagged truncated and its original size is kept.',
  maxBodyBytesPlaceholder: '(default: 262144)',
  recordAllResources: 'Keep static resources too',
  recordAllResourcesHint: 'Also record image/font/media/stylesheet requests. Off by default: they are noise for API extraction and dominate the volume.',
  recordWarning: 'These dumps contain PLAINTEXT credentials \u2014 Cookie/Set-Cookie, Authorization headers, tokens, and request/response bodies are stored verbatim, on purpose, so the offline pipeline can replay the session. Keep the directory private (the defaults are 0700/0600 under a gitignored path), never commit it, and never share it. Recorder failures never fail a fetch.',
  denoise: 'Enable the denoise algorithm',
  denoiseHint: 'Readability + DOMPurify strip nav bars, sidebars, footers, and ads before converting to markdown.',
  maxConcurrency: 'Max concurrent fetches',
  maxConcurrencyHint: 'How many pages may render at once (1–200). Blank = auto: 4 local browsers, 50 tabs for the CDP and DSH-managed backends (one browser is already alive; a slot is a tab in it).',
  maxConcurrencyPlaceholder: '(auto: local 4 / CDP 50 / managed 50)',
  challengeWaitMs: 'Cloudflare challenge wait (ms)',
  challengeWaitMsHint: 'Bounded wait for a Cloudflare challenge to clear naturally in the same tab (0–60000; 0 = off). 0 disables: the first response is returned as-is.',
  challengeWaitMsPlaceholder: '(default: 15000)',
  proxyServer: 'Outbound proxy',
  proxyServerHint: 'host:port or an http(s)/socks4/socks5 URL, e.g. http://127.0.0.1:7890. Blank = direct connection. Injected into every browser this plugin launches (local and DSH-managed). In CDP mode it is NOT applied by the plugin: a proxy is a launch-time property of that browser, so it must have been started with --proxy-server=... — use the launcher below, or the browser egresses directly. This plugin neither injects nor verifies it there, and never blocks the fetch over it.',
  proxyServerPlaceholder: 'http://127.0.0.1:7890',
  proxyBypass: 'Proxy bypass list',
  proxyBypassHint: 'Comma-separated hosts that skip the proxy. Loopback (127.0.0.1, localhost, ::1) is always bypassed.',
  proxyBypassPlaceholder: '172.16.0.0/12,*.internal',
  proxyUsername: 'Proxy username',
  proxyUsernameHint: 'Sent as Proxy-Authorization when the proxy asks for it; blank = an open proxy.',
  proxyPassword: 'Proxy password',
  proxyPasswordHint: 'Stored with the other settings and never echoed back in an error message. Blank = no authentication.',
  overridden: 'Overridden',
  reset: 'Reset to default',
  readOnly: 'This deployment stores settings read-only.',
  expand: 'Show settings',
  collapse: 'Hide settings',
  save: 'Save',
  saving: 'Saving…',
  discard: 'Discard',
  unsaved: 'Unsaved',
  saveFailed: 'The deployment did not accept these values; they were left for you to correct.',
  invalidText: 'This value is not accepted here.',
}

/** Simplified Chinese copy. */
export const zh: Record<PlaywrightCardLocaleKey, string> = {
  title: 'Playwright 网页爬取',
  description: '用真实浏览器（本地 Playwright 或 CDP）抓取网页，降噪后转为 Markdown。',
  backendLabel: 'Playwright 后端',
  backendLocal: '本地 Playwright',
  backendLocalHint: '通过本机的 playwright 安装启动一次性浏览器：每次抓取一个浏览器，不保留任何状态。',
  backendCdp: '远端 CDP 地址',
  backendCdpHint: '连接一个已在运行的浏览器的 DevTools 协议端口。该浏览器的代理必须在启动它时用 --proxy-server=... 指定：本插件既无法把代理注入到已在运行的浏览器，也无法校验它，但不会因此拒绝抓取；下方启动器会为你拼出该命令。',
  backendManaged: 'DSH 托管持久浏览器',
  backendManagedHint: '由 DSH 在持久 user-data-dir 上启动唯一的浏览器，所有抓取复用它、每次只开一个标签页：登录态跨抓取与重启保留，代理真正生效。卸载插件或改动启动设置即重新拉起。',
  playwrightPath: 'Playwright 可执行文件路径',
  playwrightPathHint: '留空则按系统 $PATH 查找 playwright；也支持填浏览器可执行文件路径。',
  playwrightPathPlaceholder: '（自动：按 $PATH 查找 playwright）',
  cdpEndpoint: 'CDP 地址',
  cdpEndpointHint: 'host:port 或 http(s)/ws 地址；留空默认 127.0.0.1:9222。',
  shareBrowserContext: '共享浏览器上下文（复用登录态）',
  shareBrowserContextHint: '每次抓取在远端浏览器的真实 profile 里开一个标签页：共享 cookie 与 localStorage、复用已登录会话，页面会看到你的登录身份；取消勾选则每次抓取使用全新隔离上下文。',
  headless: '无头运行',
  headlessHint: '勾选：不显示窗口（服务器无桌面时选它）。取消勾选：有头运行——配合本地桌面可手动登录。',
  userDataDir: '持久 profile 目录（user-data-dir）',
  userDataDirHint: '托管浏览器保存 profile 的位置——登录态、cookie、扩展都在这里。留空 = $DSH_HOME/web-fetch-playwright/profile。请把它当作凭据数据对待，插件永不清理。',
  userDataDirPlaceholder: '（默认：$DSH_HOME/web-fetch-playwright/profile）',
  launchArgs: '额外启动参数',
  launchArgsHint: '追加到本插件启动的每个浏览器（以及启动器命令），例如 --lang=zh-CN --disable-gpu；按空格拆分，含空格的值请加引号。',
  launchArgsPlaceholder: '--lang=zh-CN --disable-gpu',
  launcherPreview: '本地启动器命令（只读）',
  launcherPreviewHint: '`dsh-web-fetch-launch` 在 CDP + 反向隧道拓扑下会执行的命令：用你本机浏览器打开真实 profile 的副本、带上这里的代理、监听回环 DevTools 端口。加 --dry-run 只打印不启动；`autossh -M 0 -N -R 9222:127.0.0.1:9222 <user@server>` 把该端口送到插件所在主机。',
  recordNetwork: '抓包记录网络流量（XHR/Fetch/WebSocket）',
  recordNetworkHint: '在每次抓取打开的标签页上挂一条 CDP 会话：请求 URL/Method/Headers/Payload、响应状态/Headers/正文、WebSocket 帧，抓取进行中即以 JSONL 追加落盘，结束时导出 HAR 1.2。只记录本插件自己发起的抓取，绝不记录其它标签页。默认关闭。',
  recordDir: '落盘目录',
  recordDirHint: '基目录；每次抓包在其下新建独立的 <session> 子目录。留空 = <工作目录>/net-dumps（已 gitignore），目录 0700、文件 0600。',
  recordDirPlaceholder: '（默认：<工作目录>/net-dumps）',
  captureBodies: '抓取响应正文',
  captureBodiesHint: '通过 CDP 读取每个响应正文，受下方字节上限截断。关闭则只记 URL、状态、Headers 与请求载荷。',
  maxBodyBytes: '正文字节上限',
  maxBodyBytesHint: '单个响应正文 / WebSocket 帧的存储上限（0–16 MiB）。被截断的会标记 truncated 并保留原始字节数。',
  maxBodyBytesPlaceholder: '（默认：262144）',
  recordAllResources: '静态资源也记录',
  recordAllResourcesHint: '同时记录 image/font/media/stylesheet 请求。默认关闭：它们对提取业务 API 是噪音，且量最大。',
  recordWarning: '抓包产物含明文凭据——Cookie/Set-Cookie、Authorization 头、token 与请求/响应正文均按原样保存（这是刻意设计，供离线流水线复现会话）。请把目录当作敏感数据：默认路径已 gitignore 且权限为目录 0700 / 文件 0600，切勿提交或外发。录制失败绝不会让抓取失败。',
  denoise: '启用降噪算法',
  denoiseHint: '使用 Readability + DOMPurify 清洗导航栏、侧边栏、页脚与贴片广告后再转为 Markdown。',
  maxConcurrency: '最大并发抓取数',
  maxConcurrencyHint: '同时渲染的页面上限（1–200）；留空自动：本地 4 个浏览器，CDP 与 DSH 托管后端 50 个标签页（浏览器已在运行，一个并发名额就是一个标签页）。',
  maxConcurrencyPlaceholder: '（自动：本地 4 / CDP 50 / 托管 50）',
  challengeWaitMs: 'Cloudflare 挑战等待上限（毫秒）',
  challengeWaitMsHint: '在同一标签页内有界等待 Cloudflare 验证自然通过（0–60000；0 = 关闭）。关闭时直接返回首次响应——旧版行为。',
  challengeWaitMsPlaceholder: '（默认：15000）',
  proxyServer: '出站代理',
  proxyServerHint: 'host:port 或 http(s)/socks4/socks5 地址，例如 http://127.0.0.1:7890；留空 = 直连。会注入本插件启动的每个浏览器（本地与 DSH 托管）。CDP 模式下插件不生效：代理是该被接管浏览器自身的启动期属性，必须用它启动时的 --proxy-server=... 指定（用下方启动器即可），否则流量直连——插件既不注入也不校验，也不会因此拒绝抓取。',
  proxyServerPlaceholder: 'http://127.0.0.1:7890',
  proxyBypass: '代理绕过列表',
  proxyBypassHint: '逗号分隔、不走代理的主机。回环地址（127.0.0.1、localhost、::1）始终绕过。',
  proxyBypassPlaceholder: '172.16.0.0/12,*.internal',
  proxyUsername: '代理用户名',
  proxyUsernameHint: '代理要求认证时作为 Proxy-Authorization 发送；留空 = 开放代理。',
  proxyPassword: '代理密码',
  proxyPasswordHint: '与其他设置一起保存，且绝不会出现在任何错误信息里；留空 = 不认证。',
  overridden: '已覆盖',
  reset: '恢复默认',
  readOnly: '本部署的设置为只读。',
  expand: '展开设置',
  collapse: '收起设置',
  save: '保存',
  saving: '保存中…',
  discard: '放弃修改',
  unsaved: '未保存',
  saveFailed: '本部署没有接受这些值，已保留供你修改。',
  invalidText: '该值不被此设置项接受。',
}
