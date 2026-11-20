type WindowCommand = 'minimize' | 'maximize' | 'close';
declare const reader: {
  getVersion(): Promise<string>;
  readSubscriptions(): Promise<string>;
  fetchFeed(address: string, validators?: FeedValidators): Promise<FeedResponse>;
  readFeedCache(address: string): Promise<CachedFeed | null>;
  writeFeedCache(address: string, data: CachedFeed): Promise<void>;
  openArticle(address: string): Promise<void>;
  windowCommand(command: WindowCommand): void;
  onWindowState(callback: (maximized: boolean, focused: boolean) => void): void;
};

interface Feed { name: string; url: string }
interface ArticleContent { text: string; html: string; base?: string }
interface Entry { id: string; feed: Feed; title: string; link: string; date: number; content: ArticleContent }
interface FeedValidators { etag: string; lastModified: string }
interface CachedFeed {
  entries: Omit<Entry, 'feed'>[];
  validators: FeedValidators;
  checkedAt: number;
}
type FeedResponse = { unchanged: true } | { unchanged: false; body: string; url: string; validators: FeedValidators };

function get<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

const feedsList = get('feeds');
const articlesList = get('articles');
const preview = get('preview');
const statusBar = get('status');
const openButton = get<HTMLButtonElement>('open');
const unreadOnly = get<HTMLInputElement>('unread');
const refreshButton = get<HTMLButtonElement>('refresh');
const manageButton = get<HTMLButtonElement>('manage-feeds');
const markSubscriptionButton = get<HTMLButtonElement>('mark-subscription-read');
const markAllButton = get<HTMLButtonElement>('mark-all-read');
markSubscriptionButton.onclick = () => markAsRead(feedUrl);
markAllButton.onclick = () => markAsRead('');
const xml = new DOMParser();
let readStorageWarning = '';
const read = loadReadHistory();
const cache = new Map<string, Entry[]>();
const feedSnapshots = new Map<string, CachedFeed>();
const failedFeeds = new Map<string, string>();
const unsavedFeeds = new Set<string>();
let damagedSubscriptions: string | undefined;
let subscriptionLoadWarning = '';
let statusMessage = '';
let initialized = false;
let feeds: Feed[] = [];
let feedUrl = '';
let selected: Entry | undefined;
let refreshing = false;
let lastBulkRead: string[] = [];
const toolbarPanel = get('toolbar');
const statusPanel = get('status-bar');
for (const panel of [toolbarPanel, statusPanel]) panel.hidden = readPreference(panel.id) === 'hidden';

function readPreference(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function loadReadHistory(): Set<string> {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem('read') ?? '[]');
    if (!Array.isArray(saved) || !saved.every(id => typeof id === 'string')) throw new Error();
    return new Set(saved);
  } catch {
    readStorageWarning = 'Could not load read history.';
    return new Set();
  }
}

function setStatus(message = statusMessage): void {
  statusMessage = message;
  const cacheWarning = unsavedFeeds.size ? 'Could not save downloaded headlines for ' +
    feeds.filter(feed => unsavedFeeds.has(feed.url)).map(feed => feed.name).join(', ') + '.' : '';
  const text = [message, subscriptionLoadWarning, readStorageWarning, cacheWarning].filter(Boolean).join(' ');
  if (statusBar.textContent !== text) statusBar.textContent = text;
  statusBar.title = text;
}

function saveReadHistory(): void {
  try {
    localStorage.setItem('read', JSON.stringify([...read]));
    readStorageWarning = '';
  } catch {
    readStorageWarning = 'Could not save read history. Changes may be lost when WinReader closes.';
  }
  setStatus();
}

function togglePanel(panel: HTMLElement): void {
  panel.hidden = !panel.hidden;
  localStorage.setItem(panel.id, panel.hidden ? 'hidden' : 'visible');
}

function parseXml(raw: string): Document {
  const doc = xml.parseFromString(raw, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('Invalid XML');
  return doc;
}

function child(parent: Element, ...names: string[]): Element | undefined {
  return names.map(name => Array.from(parent.children).find(node => node.localName === name)).find(Boolean);
}

function value(parent: Element, ...names: string[]): string {
  return child(parent, ...names)?.textContent?.trim() ?? '';
}

function articleText(markup: string): string {
  const template = document.createElement('template');
  template.innerHTML = markup;
  template.content.querySelectorAll('script,style,iframe,svg,object').forEach(node => node.remove());
  template.content.querySelectorAll('p,div,li,blockquote,br,h1,h2,h3').forEach(node => node.after('\n'));
  return (template.content.textContent ?? '').trim().replace(/\n[\t ]*\n[\s\n]*/g, '\n\n');
}

interface JsonFeedItem {
  id?: string;
  url?: string;
  external_url?: string;
  title?: string;
  date_published?: string;
  date_modified?: string;
  content_text?: string;
  content_html?: string;
  summary?: string;
}

function articleUrl(address: string, base: string): string {
  if (!address) return '';
  try {
    const url = new URL(address, base || undefined);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
  } catch {
    return '';
  }
}

function feedAddressKey(address: string): string {
  const url = articleUrl(address, '');
  return url.split('#', 1)[0];
}

function parseJsonFeed(raw: string, feed: Feed, responseUrl: string): Entry[] {
  const doc = JSON.parse(raw) as { version?: string; items?: JsonFeedItem[] };
  if (typeof doc.version !== 'string' || !doc.version.startsWith('https://jsonfeed.org/version/') || !Array.isArray(doc.items)) {
    throw new Error('Unsupported JSON feed format');
  }
  const entries = new Map<string, Entry>();
  const string = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
  for (const item of doc.items) {
    if (!item || typeof item !== 'object') continue;
    const link = articleUrl(string(item.url), responseUrl) || articleUrl(string(item.external_url), responseUrl);
    const content = { html: string(item.content_html), text: string(item.content_text) || string(item.summary), base: link || responseUrl };
    const title = string(item.title) || string(item.summary).slice(0, 100) || '(Untitled)';
    const dateText = string(item.date_published) || string(item.date_modified);
    const id = JSON.stringify([feed.url, string(item.id) || link || title + dateText]);
    if (!entries.has(id)) entries.set(id, { id, feed, link, content, title, date: Date.parse(dateText) || 0 });
  }
  return [...entries.values()];
}

const xmlNamespace = 'http://www.w3.org/XML/1998/namespace';

function elementBase(element: Element, responseUrl: string): string | undefined {
  const inherited = element.parentElement ? elementBase(element.parentElement, responseUrl) : undefined;
  const local = element.getAttributeNS(xmlNamespace, 'base');
  return local ? articleUrl(local, inherited ?? responseUrl) || inherited : inherited;
}

function parseFeed(raw: string, feed: Feed, responseUrl: string): Entry[] {
  if (raw.trimStart().startsWith('{')) return parseJsonFeed(raw, feed, responseUrl);
  const root = parseXml(raw).documentElement;
  const parent = root.localName === 'rss' ? child(root, 'channel') : root;
  if (!parent || !['channel', 'feed', 'RDF'].includes(parent.localName)) throw new Error('Unsupported feed format');
  const entries = Array.from(parent.children).filter(node => ['item', 'entry'].includes(node.localName));
  const seen = new Set<string>();
  return entries.flatMap(item => {
    const alternate = Array.from(item.children).find(node =>
      node.localName === 'link' && node.hasAttribute('href') && [null, 'alternate'].includes(node.getAttribute('rel')));
    const linkElement = alternate ?? child(item, 'link');
    const link = linkElement ? articleUrl(alternate?.getAttribute('href') || value(item, 'link'),
      elementBase(linkElement, responseUrl) ?? responseUrl) : '';
    const title = articleText(value(item, 'title')) || '(Untitled)';
    const dateText = value(item, 'pubDate', 'published', 'updated', 'date');
    const id = JSON.stringify([feed.url, value(item, 'guid', 'id') || link || title + dateText]);
    if (seen.has(id)) return [];
    seen.add(id);
    const body = child(item, 'encoded', 'content', 'description', 'summary');
    const type = body?.getAttribute('type') ?? (parent.localName === 'feed' ? 'text' : 'html');
    const rawBody = body?.textContent?.trim() ?? '';
    let xhtml = '';
    if (type === 'xhtml' && body) {
      const serializer = new XMLSerializer();
      xhtml = Array.from(body.childNodes, node => serializer.serializeToString(node)).join('');
    }
    const base = (body && elementBase(body, responseUrl)) || link || responseUrl;
    const content = type === 'text' ? { text: rawBody, html: '', base } : { text: '', html: xhtml || rawBody, base };
    return [{
      id, feed, link, title,
      date: Date.parse(dateText) || 0,
      content
    }];
  });
}

function row(label: string, active: boolean, activate: () => void): HTMLLIElement {
  const item = document.createElement('li');
  item.setAttribute('role', 'option');
  item.setAttribute('aria-selected', String(active));
  item.tabIndex = active ? 0 : -1;
  item.textContent = label;
  item.title = label;
  item.addEventListener('click', activate);
  item.addEventListener('keydown', event => {
    const siblings = Array.from(item.parentElement?.querySelectorAll<HTMLLIElement>('[role="option"]') ?? []);
    const index = siblings.indexOf(item);
    const next = { ArrowUp: index - 1, ArrowDown: index + 1, Home: 0, End: siblings.length - 1 }[event.key];
    if (next !== undefined) {
      event.preventDefault();
      siblings[next]?.click();
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      activate();
    }
  });
  return item;
}

function updateUnreadCounts(): void {
  const counts = new Map<string, number>();
  let total = 0;
  for (const [url, entries] of cache) {
    const unread = entries.reduce((count, entry) => count + Number(!read.has(entry.id)), 0);
    counts.set(url, unread);
    total += unread;
  }

  markSubscriptionButton.disabled = !feedUrl || !counts.get(feedUrl);
  markAllButton.disabled = total === 0;

  for (const item of feedsList.querySelectorAll<HTMLLIElement>('li[data-feed-url]')) {
    const url = item.dataset.feedUrl!;
    const count = url ? counts.get(url) : total;
    const name = item.querySelector('.feed-name')!.textContent;
    item.querySelector('.feed-count')!.textContent = count === undefined ? '–' : '(' + count + ')';
    item.classList.toggle('unread', (count ?? 0) > 0);
    const lastChecked = feedSnapshots.get(url)?.checkedAt;
    const failure = failedFeeds.get(url);
    const unsaved = unsavedFeeds.has(url);
    item.querySelector<HTMLElement>('.feed-stale')!.hidden = !failure && !unsaved;
    const label = name + (count === undefined ? ', unread count unavailable' : ', ' + count + ' unread');
    const details = url
      ? (failure ? '. Refresh failed: ' + failure : '') +
        (unsaved ? '. Downloaded headlines could not be saved' : '') +
        (lastChecked ? '. Last successful check: ' + new Date(lastChecked).toLocaleString() : '. Never checked successfully')
      : '';
    item.setAttribute('aria-label', label + details);
    item.title = label + details;
  }
}

const feedNameOrder = new Intl.Collator(undefined, { sensitivity: 'base' });

function compareFeedNames(a: Feed, b: Feed): number {
  return feedNameOrder.compare(a.name, b.name);
}

function renderFeeds(focus = false): void {
  feedsList.replaceChildren();
  for (const feed of [{ url: '', name: 'All subscriptions' }, ...feeds]) {
    const item = row(feed.name, feed.url === feedUrl, () => {
      feedUrl = feed.url;
      selected = undefined;
      renderFeeds(true);
      renderEntries();
    });
    item.dataset.feedUrl = feed.url;
    if (feed.url) {
      item.oncontextmenu = event => {
        event.preventDefault();
        showSubscriptionMenu(item, feed.url, event.clientX, event.clientY);
      };
      item.addEventListener('keydown', event => {
        if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
        event.preventDefault();
        const bounds = item.getBoundingClientRect();
        showSubscriptionMenu(item, feed.url, bounds.left, bounds.bottom);
      });
    }
    const name = document.createElement('span');
    name.className = 'feed-name';
    name.textContent = feed.name;
    const count = document.createElement('span');
    count.className = 'feed-count';
    count.setAttribute('aria-hidden', 'true');
    const stale = document.createElement('span');
    stale.className = 'feed-stale';
    stale.textContent = '!';
    stale.setAttribute('aria-hidden', 'true');
    item.replaceChildren(name, stale, count);
    feedsList.append(item);
  }
  updateUnreadCounts();
  if (focus) feedsList.querySelector<HTMLElement>('[aria-selected="true"]')?.focus();
}

// Copy only readable elements and attributes from the inert feed markup.
const articleTags = new Set([
  'a', 'abbr', 'b', 'blockquote', 'br', 'caption', 'cite', 'code', 'dd', 'del', 'details',
  'div', 'dl', 'dt', 'em', 'figcaption', 'figure', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'hr', 'i', 'img', 'ins', 'kbd', 'li', 'mark', 'ol', 'p', 'pre', 'q', 's', 'samp',
  'small', 'span', 'strong', 'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'th',
  'thead', 'tfoot', 'tr', 'u', 'ul', 'var', 'wbr'
]);
const discardedArticleTags = new Set([
  'audio', 'button', 'embed', 'form', 'iframe', 'input', 'math', 'noscript', 'object',
  'script', 'select', 'style', 'svg', 'template', 'textarea', 'video'
]);

function copyArticleMarkup(source: Node, destination: Node, base: string): void {
  for (const node of source.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      destination.appendChild(document.createTextNode(node.textContent ?? ''));
      continue;
    }
    if (!(node instanceof Element)) continue;
    const tag = node.localName;
    if (node.namespaceURI !== 'http://www.w3.org/1999/xhtml' || discardedArticleTags.has(tag)) continue;
    const nodeBase = articleUrl(node.getAttribute('xml:base') ?? '', base) || base;
    if (!articleTags.has(tag)) {
      copyArticleMarkup(node, destination, nodeBase);
      continue;
    }

    const element = document.createElement(tag);
    const title = node.getAttribute('title');
    if (title) element.title = title;
    if (element instanceof HTMLAnchorElement) {
      const address = articleUrl(node.getAttribute('href')?.trim() ?? '', nodeBase);
      if (address) element.href = address;
    }
    if (element instanceof HTMLImageElement) {
      const address = articleUrl(node.getAttribute('src')?.trim() || node.getAttribute('data-src')?.trim() || '', nodeBase);
      element.alt = node.getAttribute('alt') ?? '';
      if (!address) {
        destination.appendChild(document.createTextNode(element.alt));
        continue;
      }
      element.loading = 'lazy';
      element.decoding = 'async';
      element.referrerPolicy = 'no-referrer';
      for (const dimension of ['width', 'height'] as const) {
        const value = node.getAttribute(dimension);
        if (value && /^[1-9][0-9]{0,3}$/.test(value)) element.setAttribute(dimension, value);
      }
      element.src = address;
    }
    if (element instanceof HTMLOListElement) {
      const start = node.getAttribute('start');
      if (start && /^-?[0-9]{1,8}$/.test(start)) element.start = Number(start);
      element.reversed = node.hasAttribute('reversed');
    }
    copyArticleMarkup(node, element, nodeBase);
    destination.appendChild(element);
  }
}

function openPreviewLink(event: MouseEvent): void {
  const anchor = (event.target as Element | null)?.closest<HTMLAnchorElement>('a[href]');
  if (!anchor || (event.type === 'auxclick' && event.button !== 1)) return;
  event.preventDefault();
  openArticle(anchor.href);
}

preview.addEventListener('click', openPreviewLink);
preview.addEventListener('auxclick', openPreviewLink);

function renderPreview(): void {
  preview.replaceChildren();
  preview.scrollTop = 0;
  openButton.disabled = !selected?.link;
  if (!selected) {
    preview.textContent = 'Select a headline to read it.';
    return;
  }
  const title = document.createElement('h3');
  title.className = 'article-title';
  title.textContent = selected.title;
  const metadata = document.createElement('p');
  metadata.className = 'metadata';
  metadata.textContent = selected.feed.name + (selected.date ? ' · ' + new Date(selected.date).toLocaleString() : '');
  const body = document.createElement('div');
  body.className = 'article-body';
  if (selected.content.html) {
    const template = document.createElement('template');
    template.innerHTML = selected.content.html;
    copyArticleMarkup(template.content, body, selected.content.base || selected.link || selected.feed.url);
  }
  if (!body.textContent?.trim() && !body.querySelector('img')) {
    body.classList.add('plain-text');
    body.textContent = selected.content.text || 'This feed entry has no preview.';
  }
  preview.append(title, metadata, body);
}

function renderEntries(updatePreview = true): void {
  const previousScroll = articlesList.scrollTop;
  const entries = [...cache.values()].flat().filter(entry => !feedUrl || entry.feed.url === feedUrl)
    .sort((a, b) => b.date - a.date);
  const visible = entries.filter(entry => !unreadOnly.checked || !read.has(entry.id) || entry.id === selected?.id);
  articlesList.replaceChildren();
  for (const entry of visible) {
    const item = row(entry.title, selected?.id === entry.id, () => {
      if (selected?.id === entry.id) {
        item.focus();
        return;
      }
      selected = entry;
      read.add(entry.id);
      saveReadHistory();
      updateUnreadCounts();
      if (unreadOnly.checked) {
        for (const stale of articlesList.querySelectorAll<HTMLLIElement>('[aria-selected="true"]')) stale.remove();
      }
      for (const option of articlesList.querySelectorAll<HTMLLIElement>('[role="option"]')) {
        option.setAttribute('aria-selected', String(option === item));
        option.tabIndex = option === item ? 0 : -1;
      }
      item.classList.remove('unread');
      item.focus();
      const count = articlesList.childElementCount;
      get('count').textContent = count + (count === 1 ? ' headline' : ' headlines');
      renderPreview();
    });
    item.classList.toggle('unread', !read.has(entry.id));
    item.addEventListener('dblclick', openSelected);
    articlesList.append(item);
  }
  if (!visible.length) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = refreshing ? 'Retrieving headlines…' : 'No headlines to display.';
    articlesList.append(empty);
  }
  articlesList.scrollTop = previousScroll;
  const active = articlesList.querySelector<HTMLElement>('[aria-selected="true"]');
  const first = articlesList.querySelector<HTMLElement>('[role="option"]');
  if (!active && first) first.tabIndex = 0;
  get('count').textContent = visible.length + (visible.length === 1 ? ' headline' : ' headlines');
  if (updatePreview) renderPreview();
}

for (const [scroller, label] of [
  [feedsList, 'subscriptions'], [articlesList, 'headlines'], [preview, 'article'],
  [get('subscription-list'), 'subscription list']
] as const) {
  const frame = document.createElement('div');
  frame.className = 'scroll-frame';
  scroller.before(frame);
  frame.append(scroller);
  const buttons = ['up', 'down'].map(direction => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'scroll-arrow scroll-' + direction;
    button.setAttribute('aria-label', 'Scroll ' + label + ' ' + direction);
    button.setAttribute('aria-controls', scroller.id);
    button.hidden = true;
    button.onclick = () => scroller.scrollBy(0, direction === 'up' ? -24 : 24);
    frame.append(button);
    return button;
  });

  function updateScrollArrows(): void {
    const overflows = scroller.scrollHeight > scroller.clientHeight;
    frame.classList.toggle('has-scrollbar', overflows);
    for (const button of buttons) button.hidden = !overflows;
  }
  scroller.addEventListener('load', updateScrollArrows, true);
  scroller.addEventListener('toggle', updateScrollArrows, true);
  new ResizeObserver(updateScrollArrows).observe(scroller);
  new MutationObserver(updateScrollArrows).observe(scroller, {
    childList: true,
    subtree: true,
    ...(scroller === preview ? { attributes: true, attributeFilter: ['style'] } : {})
  });
}

const panes = document.querySelector<HTMLElement>('.panes')!;
const dividers = Array.from(panes.querySelectorAll<HTMLElement>('.pane-divider'));
const minSubscriptions = 130;
const minHeadlines = 145;
const minArticle = 200;
let preferredWidths: number[] | undefined;
try {
  const saved = JSON.parse(localStorage.getItem('pane-widths') ?? 'null');
  if (Array.isArray(saved) && saved.length === 2 && saved.every(Number.isFinite)) preferredWidths = saved;
} catch {
  // The default widths remain available when saved preferences cannot be read.
}

function clampWidth(width: number, min: number, max: number): number {
  return Math.min(Math.max(Math.round(width), min), Math.max(min, max));
}

function availablePaneWidth(): number {
  return panes.clientWidth - dividers.reduce((width, divider) => width + divider.offsetWidth, 0);
}

function paneWidths(): [number, number] {
  const available = availablePaneWidth();
  const subscriptions = clampWidth(preferredWidths?.[0] ?? available * .21, minSubscriptions, available - minHeadlines - minArticle);
  const headlines = clampWidth(preferredWidths?.[1] ?? available * .31, minHeadlines, available - subscriptions - minArticle);
  return [subscriptions, headlines];
}

function applyPaneWidths(): void {
  const [subscriptions, headlines] = paneWidths();
  panes.style.setProperty('--subscriptions-width', subscriptions + 'px');
  panes.style.setProperty('--headlines-width', headlines + 'px');
  const ranges = [
    [minSubscriptions, subscriptions + headlines - minHeadlines, subscriptions],
    [minHeadlines, availablePaneWidth() - subscriptions - minArticle, headlines]
  ];
  dividers.forEach((divider, index) => {
    const [min, max, value] = ranges[index];
    divider.setAttribute('aria-valuemin', String(min));
    divider.setAttribute('aria-valuemax', String(max));
    divider.setAttribute('aria-valuenow', String(value));
    divider.setAttribute('aria-valuetext', value + ' pixels');
  });
}

function resizedWidths(index: number, delta: number, existing: [number, number]): [number, number] {
  const [subscriptions, headlines] = existing;
  if (index === 0) {
    const width = clampWidth(subscriptions + delta, minSubscriptions, subscriptions + headlines - minHeadlines);
    return [width, subscriptions + headlines - width];
  }
  return [subscriptions, clampWidth(headlines + delta, minHeadlines, availablePaneWidth() - subscriptions - minArticle)];
}

function savePaneWidths(widths: [number, number]): void {
  preferredWidths = widths;
  applyPaneWidths();
  try {
    localStorage.setItem('pane-widths', JSON.stringify(widths));
  } catch {
    // The current window still uses the chosen widths.
  }
}

dividers.forEach((divider, index) => {
  let drag: { pointer: number; start: number; widths: [number, number] } | undefined;
  function updateGuide(clientX: number): void {
    if (!drag) return;
    const [subscriptions, headlines] = resizedWidths(index, clientX - drag.start, drag.widths);
    const position = index === 0 ? subscriptions : subscriptions + headlines + dividers[0].offsetWidth;
    panes.style.setProperty('--divider-guide', position + 'px');
  }

  function endDrag(): void {
    drag = undefined;
    panes.classList.remove('dragging');
  }

  divider.onpointerdown = event => {
    if (event.button !== 0 || drag) return;
    event.preventDefault();
    divider.focus();
    divider.setPointerCapture(event.pointerId);
    drag = { pointer: event.pointerId, start: event.clientX, widths: paneWidths() };
    panes.classList.add('dragging');
    updateGuide(event.clientX);
  };
  document.addEventListener('pointermove', event => {
    if (event.pointerId === drag?.pointer) updateGuide(event.clientX);
  });
  document.addEventListener('pointerup', event => {
    if (event.pointerId !== drag?.pointer) return;
    if (event.clientX !== drag.start) savePaneWidths(resizedWidths(index, event.clientX - drag.start, drag.widths));
    endDrag();
  });
  divider.onlostpointercapture = endDrag;
  divider.onkeydown = event => {
    const step = event.shiftKey ? 32 : 8;
    const delta = { ArrowLeft: -step, ArrowRight: step, Home: -panes.clientWidth, End: panes.clientWidth }[event.key];
    if (delta === undefined) return;
    event.preventDefault();
    savePaneWidths(resizedWidths(index, delta, paneWidths()));
  };
});
new ResizeObserver(applyPaneWidths).observe(panes);
applyPaneWidths();

function feedRequestError(error: unknown): string {
  return error instanceof Error
    ? error.message.replace(/^Error invoking remote method 'feed:fetch': (?:Error: )?/, '')
    : 'Could not download the feed.';
}

function parseDownloadedFeed(response: Extract<FeedResponse, { unchanged: false }>, feed: Feed): Entry[] {
  try {
    return parseFeed(response.body, feed, response.url);
  } catch {
    throw new Error('The response is not a valid RSS, Atom, or JSON feed.');
  }
}

async function refresh(): Promise<void> {
  if (!initialized || refreshing) return;
  const subscriptions = feeds;
  refreshing = true;
  refreshButton.disabled = true;
  const hourglass = get('refresh-hourglass');
  let completed = 0;
  function showProgress(): void {
    setStatus('Refreshing ' + completed + ' of ' + subscriptions.length + ' feeds…');
  }
  hourglass.hidden = !subscriptions.length;
  showProgress();
  if (!cache.size) renderEntries();
  async function checkFeed(feed: Feed) {
    try {
      const snapshot = feedSnapshots.get(feed.url);
      const validators = snapshot?.entries.every(entry => entry.content.base) ? snapshot.validators : undefined;
      const response = await reader.fetchFeed(feed.url, validators).catch(error => {
        throw new Error(feedRequestError(error));
      });
      const checkedAt = Date.now();
      if (response.unchanged) {
        if (!snapshot) throw new Error('Missing cached feed');
        return { changed: false, snapshot: { ...snapshot, checkedAt } };
      }
      const entries = parseDownloadedFeed(response, feed).map(({ feed: _feed, ...entry }) => entry);
      return { changed: true, snapshot: { entries, validators: response.validators, checkedAt } };
    } finally {
      completed++;
      if (subscriptions === feeds) showProgress();
    }
  }
  const results: PromiseSettledResult<Awaited<ReturnType<typeof checkFeed>>>[] = [];
  for (let start = 0; start < subscriptions.length && subscriptions === feeds; start += 8) {
    results.push(...await Promise.allSettled(subscriptions.slice(start, start + 8).map(checkFeed)));
  }
  if (subscriptions !== feeds) {
    refreshing = false;
    return refresh();
  }

  const failures: Feed[] = [];
  const writes: Promise<void>[] = [];
  let changed = false;
  let unchanged = 0;
  results.forEach((result, index) => {
    const feed = subscriptions[index];
    if (result.status === 'rejected') {
      failedFeeds.set(feed.url, result.reason instanceof Error ? result.reason.message : 'Could not refresh the feed.');
      failures.push(feed);
      return;
    }
    const update = result.value;
    feedSnapshots.set(feed.url, update.snapshot);
    failedFeeds.delete(feed.url);
    if (update.changed) {
      changed = true;
      cache.set(feed.url, update.snapshot.entries.map(entry => ({ ...entry, feed })));
    } else {
      unchanged++;
    }
    writes.push(reader.writeFeedCache(feed.url, update.snapshot).then(
      () => { unsavedFeeds.delete(feed.url); },
      () => { if (feeds.some(current => current.url === feed.url)) unsavedFeeds.add(feed.url); }
    ));
  });
  await Promise.all(writes);
  if (subscriptions !== feeds) {
    refreshing = false;
    return refresh();
  }
  updateUnreadCounts();
  const success = subscriptions.length - failures.length;
  const count = success + (success === 1 ? ' feed' : ' feeds');
  const summary = unchanged ? `Checked ${count} (${unchanged} unchanged).` : `Updated ${count}.`;
  setStatus(failures.length
    ? `${summary} Unavailable: ${failures.map(feed => feed.name + ' (' + failedFeeds.get(feed.url) + ')').join(', ')}`
    : subscriptions.length ? summary : 'No subscriptions. Use Subscriptions… to add a feed.');
  refreshing = false;
  refreshButton.disabled = false;
  hourglass.hidden = true;
  if (changed || !cache.size) {
    const previous = selected;
    const previewScroll = preview.scrollTop;
    const headlineFocused = articlesList.contains(document.activeElement);
    if (previous) selected = cache.get(previous.feed.url)?.find(entry => entry.id === previous.id);
    renderEntries(previous !== selected);
    if (selected?.id === previous?.id) preview.scrollTop = previewScroll;
    if (headlineFocused) articlesList.querySelector<HTMLElement>('[tabindex="0"]')?.focus({ preventScroll: true });
  }
}

function markAsRead(url: string): void {
  const groups = url ? [cache.get(url) ?? []] : cache.values();
  const changed: string[] = [];
  for (const entries of groups) {
    for (const entry of entries) {
      if (read.has(entry.id)) continue;
      read.add(entry.id);
      changed.push(entry.id);
    }
  }
  if (!changed.length) return;
  lastBulkRead = changed;
  updateBulkReadState();
}

function undoMarkAsRead(): void {
  if (!lastBulkRead.length) return;
  for (const id of lastBulkRead) read.delete(id);
  lastBulkRead = [];
  updateBulkReadState();
}

function updateBulkReadState(): void {
  saveReadHistory();
  updateUnreadCounts();
  renderEntries(false);
}

function openArticle(link: string): void {
  reader.openArticle(link).catch(() => setStatus('Could not open the article link.'));
}

function openSelected(): void {
  if (selected?.link) openArticle(selected.link);
}

const systemButton = get<HTMLButtonElement>('system-button');
const menuButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('.menubar button'));
const popup = get('popup');
const submenu = get('submenu');
const articleSizes = [
  { pixels: 20, label: 'Largest' },
  { pixels: 16, label: 'Larger' },
  { pixels: 14, label: 'Medium' },
  { pixels: 12, label: 'Smaller' },
  { pixels: 11, label: 'Smallest' }
];
const sizeDialog = get<HTMLDialogElement>('article-size-dialog');
const sizeSelect = get<HTMLSelectElement>('article-size');
const sizeSample = get('article-size-sample');
const savedSize = Number(readPreference('article-font-size'));
let articleSize = articleSizes.some(size => size.pixels === savedSize) ? savedSize : 14;
preview.style.setProperty('--article-font-size', articleSize + 'px');

function setArticleSize(pixels: number): void {
  if (pixels === articleSize) return;
  const scrollable = preview.scrollHeight - preview.clientHeight;
  const position = scrollable > 0 ? preview.scrollTop / scrollable : 0;
  articleSize = pixels;
  preview.style.setProperty('--article-font-size', pixels + 'px');
  preview.scrollTop = position * (preview.scrollHeight - preview.clientHeight);
  localStorage.setItem('article-font-size', String(pixels));
}

for (const { pixels } of [...articleSizes].reverse()) {
  sizeSelect.add(new Option(Number((pixels * .75).toFixed(2)) + ' pt', String(pixels)));
}

function updateSizeSample(): void {
  sizeSample.style.setProperty('--article-font-size', sizeSelect.value + 'px');
}

function showSizeDialog(): void {
  sizeSelect.value = String(articleSize);
  updateSizeSample();
  sizeDialog.showModal();
}

sizeSelect.onchange = updateSizeSample;
get('cancel-article-size').onclick = () => sizeDialog.close();
get<HTMLFormElement>('article-size-form').onsubmit = event => {
  event.preventDefault();
  setArticleSize(Number(sizeSelect.value));
  sizeDialog.close();
};
const closeWindowButton = get<HTMLButtonElement>('close-window');
const dosCommands = get('dos-commands');
const appearances = [
  { id: 'win31', label: 'Windows 3.1' },
  { id: 'win98', label: 'Windows 98' },
  { id: 'xp', label: 'Windows XP' },
  { id: 'dos', label: 'DOS Commander' }
] as const;
type Appearance = typeof appearances[number]['id'];
const savedAppearance = readPreference('appearance');
let appearance: Appearance = appearances.find(({ id }) => id === savedAppearance)?.id ?? 'win31';

function applyAppearance(next: Appearance): void {
  const positions = [feedsList, articlesList, preview].map(pane => [pane, pane.scrollTop, pane.scrollLeft] as const);
  document.documentElement.dataset.appearance = next;
  if (next === 'dos') panes.after(toolbarPanel);
  else if (panes.previousElementSibling !== toolbarPanel) panes.before(toolbarPanel);
  closeWindowButton.hidden = next !== 'xp' && next !== 'win98';
  dosCommands.hidden = next !== 'dos';
  appearance = next;
  for (const [pane, top, left] of positions) pane.scrollTo(left, top);
}

function chooseAppearance(next: Appearance): void {
  if (next === appearance) return;
  applyAppearance(next);
  localStorage.setItem('appearance', next);
}

applyAppearance(appearance);
closeWindowButton.onclick = () => reader.windowCommand('close');
const about = get<HTMLDialogElement>('about');
let menuAnchor: HTMLElement | undefined;
let menuReturnFocus: HTMLElement | undefined;
let submenuHoverTimer: number | undefined;
let maximized = false;
type MenuItem = [label: string, shortcut: string, action: () => void, disabled?: boolean, checked?: boolean];

function closeMenu(restoreFocus = false, keepMenuMode = false): void {
  const anchor = menuAnchor;
  const returnFocus = menuReturnFocus ?? anchor;
  if (!keepMenuMode) menuReturnFocus = undefined;
  closeSubmenu();
  menuAnchor = undefined;
  popup.hidden = true;
  if (anchor instanceof HTMLButtonElement) anchor.setAttribute('aria-expanded', 'false');
  if (restoreFocus) returnFocus?.focus({ preventScroll: true });
}

function showMenu(anchor: HTMLButtonElement): void {
  closeMenu(false, true);
  const menu = anchor.dataset.menu;
  const items: (MenuItem | null)[] = menu === 'file' ? [
    ['Open Article', '', openSelected, !selected?.link],
    null,
    ['Subscriptions…', '', manageSubscriptions, manageButton.disabled],
    ['Import Subscriptions…', '', showImportSubscriptions, !initialized],
    null,
    ['Close Window', '', () => reader.windowCommand('close')]
  ] : menu === 'edit' ? [
    ['Undo Mark as Read', 'Ctrl+Z', undoMarkAsRead, !lastBulkRead.length]
  ] : menu === 'view' ? [
    [unreadOnly.checked ? 'Show All Headlines' : 'Show Unread Only', '', () => unreadOnly.click()],
    null,
    ['Toolbar', '', () => togglePanel(toolbarPanel), false, !toolbarPanel.hidden],
    ['Status Bar', '', () => togglePanel(statusPanel), false, !statusPanel.hidden],
    null,
    appearance === 'xp' ? ['Text Size', '▸', showTextSize] : ['Article Font Size…', '', showSizeDialog],
    ['Appearance', '▸', showAppearance]
  ] : menu === 'feed' ? [
    ['Refresh', 'F5', refresh, refreshing],
    null,
    ['Mark Subscription as Read', '', () => markSubscriptionButton.click(), markSubscriptionButton.disabled],
    ['Mark All Subscriptions as Read', '', () => markAllButton.click(), markAllButton.disabled]
  ] : menu === 'help' ? [
    ['About WinReader', '', () => {
      about.showModal();
      void reader.getVersion().then(version => {
        get('about-version').textContent = 'Version ' + version;
      }, () => {
        get('about-version').textContent = 'Version unavailable';
      });
    }]
  ] : [
    ['Minimize', '', () => reader.windowCommand('minimize')],
    [maximized ? 'Restore' : 'Maximize', '', () => reader.windowCommand('maximize')],
    ['Close', '', () => reader.windowCommand('close')]
  ];
  const bounds = anchor.getBoundingClientRect();
  openPopup(anchor, items, bounds.left, bounds.bottom);
}

function showSubscriptionMenu(anchor: HTMLElement, url: string, x: number, y: number): void {
  closeMenu();
  anchor.focus({ preventScroll: true });
  openPopup(anchor, [
    ['Mark Subscription as Read', '', () => markAsRead(url), !(cache.get(url) ?? []).some(entry => !read.has(entry.id))],
    null,
    ['Edit Subscription…', '', () => manageSubscriptions(url, 'edit')],
    ['Delete Subscription…', '', () => manageSubscriptions(url, 'delete')]
  ], x, y);
}

function openPopup(anchor: HTMLElement, items: (MenuItem | null)[], x: number, y: number): void {
  popup.replaceChildren();
  for (const item of items) {
    if (!item) {
      const separator = document.createElement('hr');
      separator.setAttribute('role', 'separator');
      popup.append(separator);
      continue;
    }
    const [label, shortcut, action, disabled, checked] = item;
    const button = document.createElement('button');
    button.setAttribute('role', checked === undefined ? 'menuitem' : 'menuitemcheckbox');
    if (checked !== undefined) button.setAttribute('aria-checked', String(checked));
    button.disabled = Boolean(disabled);
    const hint = document.createElement('span');
    hint.textContent = shortcut;
    button.append(label, hint);
    if (action === showAppearance || action === showTextSize) {
      button.setAttribute('aria-haspopup', 'menu');
      button.setAttribute('aria-expanded', 'false');
      button.setAttribute('aria-controls', submenu.id);
      button.dataset.submenu = label;
      button.onclick = () => action();
    } else {
      button.onclick = () => { closeMenu(true); action(); };
    }
    popup.append(button);
  }
  if (anchor instanceof HTMLButtonElement) anchor.setAttribute('aria-expanded', 'true');
  menuAnchor = anchor;
  popup.hidden = false;
  popup.style.left = Math.max(0, Math.min(x, innerWidth - popup.offsetWidth - 3)) + 'px';
  popup.style.top = Math.max(0, Math.min(y, innerHeight - popup.offsetHeight - 3)) + 'px';
  popup.querySelector<HTMLElement>('button:not(:disabled)')?.focus();
}

function closeSubmenu(restoreFocus = false): void {
  window.clearTimeout(submenuHoverTimer);
  submenu.hidden = true;
  const trigger = popup.querySelector<HTMLButtonElement>('[aria-controls="submenu"][aria-expanded="true"]');
  trigger?.setAttribute('aria-expanded', 'false');
  if (restoreFocus) trigger?.focus();
}

function showAppearance(focus = true): void {
  openChoiceMenu('Appearance', appearances.map(({ id, label }) =>
    [label, appearance === id, () => chooseAppearance(id)]
  ), focus);
}

function showTextSize(focus = true): void {
  openChoiceMenu('Text Size', articleSizes.map(({ pixels, label }) =>
    [label, pixels === articleSize, () => setArticleSize(pixels)]
  ), focus);
}

function openChoiceMenu(label: string, choices: [label: string, checked: boolean, choose: () => void][], focus: boolean): void {
  closeSubmenu();
  const trigger = Array.from(popup.querySelectorAll<HTMLButtonElement>('[data-submenu]'))
    .find(button => button.dataset.submenu === label);
  if (!trigger) return;
  submenu.setAttribute('aria-label', label);
  submenu.replaceChildren();
  for (const [label, checked, choose] of choices) {
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('role', 'menuitemradio');
    button.setAttribute('aria-checked', String(checked));
    button.textContent = label;
    button.onclick = () => { closeMenu(true); choose(); };
    submenu.append(button);
  }
  trigger.setAttribute('aria-expanded', 'true');
  submenu.hidden = false;
  const bounds = trigger.getBoundingClientRect();
  const left = bounds.right + submenu.offsetWidth <= innerWidth
    ? bounds.right : bounds.left - submenu.offsetWidth;
  submenu.style.left = Math.max(0, left) + 'px';
  submenu.style.top = Math.max(0, Math.min(bounds.top, innerHeight - submenu.offsetHeight - 3)) + 'px';
  if (focus) submenu.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
}

// Give the pointer time to cross neighboring rows on the way to either side of the flyout.
popup.addEventListener('pointerover', event => {
  if (event.pointerType !== 'mouse') return;
  const row = (event.target as Element).closest<HTMLButtonElement>('button');
  if (row?.contains(event.relatedTarget as Node | null)) return;
  window.clearTimeout(submenuHoverTimer);
  if (row?.getAttribute('aria-expanded') === 'true') return;
  submenuHoverTimer = window.setTimeout(() => {
    if (row?.dataset.submenu === 'Appearance') showAppearance(false);
    else if (row?.dataset.submenu === 'Text Size') showTextSize(false);
    else closeSubmenu(submenu.contains(document.activeElement));
  }, 300);
});
popup.addEventListener('pointerleave', () => {
  window.clearTimeout(submenuHoverTimer);
  if (!submenu.hidden) {
    submenuHoverTimer = window.setTimeout(() => closeSubmenu(submenu.contains(document.activeElement)), 300);
  }
});
submenu.addEventListener('pointerenter', () => window.clearTimeout(submenuHoverTimer));
submenu.addEventListener('pointerleave', () => {
  if (!submenu.hidden) {
    submenuHoverTimer = window.setTimeout(() => closeSubmenu(submenu.contains(document.activeElement)), 300);
  }
});

for (const button of [systemButton, ...menuButtons]) {
  button.onclick = () => menuAnchor === button ? closeMenu(true) : showMenu(button);
  button.onkeydown = event => {
    if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
      event.preventDefault();
      event.stopPropagation();
      showMenu(button);
      if (event.key === 'ArrowUp') {
        Array.from(popup.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')).at(-1)?.focus();
      }
    }
    const index = menuButtons.indexOf(button);
    if (index >= 0 && ['ArrowLeft', 'ArrowRight'].includes(event.key)) {
      event.preventDefault();
      menuButtons[(index + (event.key === 'ArrowLeft' ? -1 : 1) + menuButtons.length) % menuButtons.length].focus();
    }
  };
}

document.addEventListener('pointerdown', event => {
  const target = event.target as Node;
  if (menuReturnFocus && !menuAnchor && !targetIsMenuBar(target)) closeMenu();
  if (!submenu.hidden && popup.contains(target)
      && !(target as Element).closest('[aria-controls="submenu"]')) closeSubmenu();
  if (menuAnchor && !popup.contains(target) && !submenu.contains(target) && !menuAnchor.contains(target)) closeMenu();
});
document.addEventListener('focusin', event => {
  const target = event.target as Node;
  if (menuAnchor && !popup.contains(target) && !submenu.contains(target) && !menuAnchor.contains(target)) closeMenu();
  else if (menuReturnFocus && !menuAnchor && !targetIsMenuBar(target)) closeMenu();
});

function targetIsMenuBar(target: Node): boolean {
  return menuButtons.some(button => button.contains(target));
}

function enterMenuMode(): void {
  const active = document.activeElement;
  if (!menuReturnFocus && !menuAnchor && active instanceof HTMLElement) menuReturnFocus = active;
}

const dosActions: Record<string, () => void> = {
  F2: () => manageButton.click(),
  F3: () => openButton.click(),
  F5: () => refreshButton.click(),
  F9: () => {
    enterMenuMode();
    showMenu(menuButtons[0]);
  },
  F10: () => reader.windowCommand('close')
};
for (const button of dosCommands.querySelectorAll<HTMLButtonElement>('button[data-key]')) {
  const key = button.dataset.key!;
  button.onclick = dosActions[key];
  button.setAttribute('aria-keyshortcuts', key);
  const source = { F2: manageButton, F3: openButton, F5: refreshButton }[key];
  if (!source) continue;
  const syncDisabled = () => { button.disabled = source.disabled; };
  syncDisabled();
  new MutationObserver(syncDisabled).observe(source, { attributeFilter: ['disabled'] });
}

document.addEventListener('keydown', event => {
  if (document.querySelector('dialog[open]')) return;
  window.clearTimeout(submenuHoverTimer);
  if (appearance === 'dos' && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey
      && Object.hasOwn(dosActions, event.key)) {
    event.preventDefault();
    if (!event.repeat || event.key === 'F5') dosActions[event.key]();
    return;
  }
  if (event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey
      && event.code === 'KeyZ' && !(event.target as Element | null)?.closest('input, textarea, [contenteditable]')) {
    event.preventDefault();
    if (menuAnchor) closeMenu(true);
    undoMarkAsRead();
  }
  if (event.key === 'F5') {
    event.preventDefault();
    void refresh();
  }
  if (appearance !== 'dos' && event.key === 'F10'
      && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
    event.preventDefault();
    if (!event.repeat) toggleKeyboardMenu();
    return;
  }
  if (appearance !== 'dos' && event.altKey && event.code === 'Space') {
    event.preventDefault();
    enterMenuMode();
    showMenu(systemButton);
    return;
  }
  if (!event.ctrlKey && !event.metaKey && (event.altKey || (menuReturnFocus && !menuAnchor))) {
    const menu = { KeyF: 'file', KeyE: 'edit', KeyV: 'view', KeyD: 'feed', KeyH: 'help' }[event.code];
    const button = menuButtons.find(button => button.dataset.menu === menu);
    if (button) {
      event.preventDefault();
      enterMenuMode();
      showMenu(button);
      return;
    }
  }
  if (!menuAnchor) {
    if (menuReturnFocus && event.key === 'Escape') {
      event.preventDefault();
      closeMenu(true);
    }
    return;
  }
  if (!submenu.hidden && ['Escape', 'ArrowLeft'].includes(event.key)) {
    event.preventDefault();
    closeSubmenu(true);
    return;
  }
  const active = document.activeElement;
  if (event.key === 'ArrowRight' && active instanceof HTMLButtonElement && active.getAttribute('aria-controls') === submenu.id) {
    event.preventDefault();
    active.click();
    return;
  }
  if (event.key === 'Escape') {
    event.preventDefault();
    closeMenu(true);
    return;
  }
  if (['ArrowUp', 'ArrowDown'].includes(event.key)) {
    event.preventDefault();
    const activeMenu = submenu.contains(active) ? submenu : popup;
    if (activeMenu === popup) closeSubmenu();
    const buttons = Array.from(activeMenu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
    const index = buttons.findIndex(button => button === document.activeElement);
    const next = index < 0 ? (event.key === 'ArrowUp' ? buttons.length - 1 : 0)
      : (index + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length;
    buttons[next]?.focus();
  }
  const index = menuAnchor instanceof HTMLButtonElement ? menuButtons.indexOf(menuAnchor) : -1;
  if (submenu.hidden && index >= 0 && ['ArrowLeft', 'ArrowRight'].includes(event.key)) {
    event.preventDefault();
    showMenu(menuButtons[(index + (event.key === 'ArrowLeft' ? -1 : 1) + menuButtons.length) % menuButtons.length]);
  }
});

let altPressed = false;
document.addEventListener('keydown', event => {
  if (event.key !== 'Alt') altPressed = false;
  else if (!event.repeat) altPressed = !event.ctrlKey && !event.metaKey && !event.shiftKey;
});
window.addEventListener('blur', () => { altPressed = false; });
function toggleKeyboardMenu(): void {
  if (menuAnchor || menuReturnFocus) closeMenu(true);
  else {
    enterMenuMode();
    menuButtons[0].focus();
  }
}
document.addEventListener('keyup', event => {
  if (event.key !== 'Alt') return;
  const bareAlt = altPressed;
  altPressed = false;
  if (bareAlt && !document.querySelector('dialog[open]')) {
    toggleKeyboardMenu();
  }
});

systemButton.ondblclick = () => reader.windowCommand('close');
get('minimize').onclick = () => reader.windowCommand('minimize');
get('maximize').onclick = () => reader.windowCommand('maximize');
reader.onWindowState((isMaximized, focused) => {
  maximized = isMaximized;
  document.body.classList.toggle('maximized', maximized);
  document.body.classList.toggle('inactive', !focused);
  get('maximize').setAttribute('aria-label', maximized ? 'Restore' : 'Maximize');
  get('maximize').title = maximized ? 'Restore' : 'Maximize';
});
refreshButton.onclick = refresh;
openButton.onclick = openSelected;
unreadOnly.onchange = () => {
  if (unreadOnly.checked && selected && read.has(selected.id)) selected = undefined;
  renderEntries();
};

const subscriptionsDialog = get<HTMLDialogElement>('subscriptions-dialog');
const subscriptionList = get<HTMLSelectElement>('subscription-list');
const subscriptionError = get('subscription-error');
const editButton = get<HTMLButtonElement>('edit-feed');
const deleteButton = get<HTMLButtonElement>('delete-feed');
const editor = get<HTMLDialogElement>('feed-editor');
const feedName = get<HTMLInputElement>('feed-name');
const feedAddress = get<HTMLInputElement>('feed-address');
const feedError = get('feed-error');
const testFeedButton = get<HTMLButtonElement>('test-feed');
const feedTestStatus = get('feed-test-status');
let feedTestGeneration = 0;
const deleteDialog = get<HTMLDialogElement>('delete-confirmation');
let draft: Feed[] = [];
let editingIndex = -1;
let deletingIndex = -1;
let contextAction: 'edit' | 'delete' | undefined;

function updateSubscriptionButtons(): void {
  editButton.disabled = deleteButton.disabled = subscriptionList.selectedIndex < 0;
}

function renderSubscriptionList(index: number): void {
  subscriptionList.replaceChildren();
  for (const feed of draft) {
    const option = new Option(feed.name === feed.url ? feed.url : feed.name + ' — ' + feed.url);
    option.title = feed.url;
    subscriptionList.add(option);
  }
  subscriptionList.selectedIndex = Math.min(index, draft.length - 1);
  updateSubscriptionButtons();
}

function manageSubscriptions(url = feedUrl, action?: 'edit' | 'delete'): void {
  contextAction = action;
  draft = [...feeds];
  subscriptionError.textContent = subscriptionLoadWarning;
  subscriptionError.hidden = !subscriptionLoadWarning;
  renderSubscriptionList(Math.max(0, draft.findIndex(feed => feed.url === url)));
  subscriptionsDialog.showModal();
  if (draft.length) subscriptionList.focus();
  else get('add-feed').focus();
  if (action === 'edit') editButton.click();
  if (action === 'delete') deleteButton.click();
}

function showFeedEditor(index: number): void {
  editingIndex = index;
  const feed = draft[index];
  get('editor-title').textContent = feed ? 'Edit Feed' : 'Add Feed';
  feedName.value = feed?.name ?? '';
  feedAddress.value = feed?.url ?? '';
  feedError.hidden = true;
  feedAddress.removeAttribute('aria-invalid');
  resetFeedTest();
  editor.showModal();
  feedAddress.focus();
  if (feed) feedAddress.select();
}

manageButton.onclick = () => manageSubscriptions();
subscriptionList.onchange = updateSubscriptionButtons;
subscriptionList.ondblclick = () => {
  if (subscriptionList.selectedIndex >= 0) showFeedEditor(subscriptionList.selectedIndex);
};
subscriptionList.onkeydown = event => {
  if (subscriptionList.selectedIndex < 0) return;
  if (event.key === 'Delete') deleteButton.click();
  else return;
  event.preventDefault();
};
get('add-feed').onclick = () => showFeedEditor(-1);
editButton.onclick = () => showFeedEditor(subscriptionList.selectedIndex);
get('cancel-editor').onclick = () => editor.close();

function validatedFeedAddress(): string {
  const url = feedAddressKey(feedAddress.value.trim());
  const previous = draft[editingIndex];
  const unchanged = previous && feedAddressKey(previous.url) === url;
  const duplicate = url && !unchanged && draft.some(feed => feedAddressKey(feed.url) === url);
  if (!url || duplicate) {
    feedError.textContent = duplicate ? 'This feed is already in your subscriptions.' : 'Enter a complete HTTP or HTTPS feed URL.';
    feedError.hidden = false;
    feedAddress.setAttribute('aria-invalid', 'true');
    feedAddress.focus();
    return '';
  }
  feedError.hidden = true;
  feedAddress.removeAttribute('aria-invalid');
  return url;
}

function resetFeedTest(): void {
  feedTestGeneration++;
  feedTestStatus.hidden = true;
  testFeedButton.disabled = false;
}

feedAddress.oninput = () => {
  feedError.hidden = true;
  feedAddress.removeAttribute('aria-invalid');
  resetFeedTest();
};

testFeedButton.onclick = async () => {
  const url = validatedFeedAddress();
  if (!url) return;
  const generation = ++feedTestGeneration;
  testFeedButton.disabled = true;
  feedTestStatus.hidden = false;
  feedTestStatus.textContent = 'Testing feed…';
  let result: string;
  try {
    const response = await reader.fetchFeed(url);
    if (response.unchanged) throw new Error('The server returned no feed to test.');
    const count = parseDownloadedFeed(response, { url, name: '' }).length;
    result = 'Valid feed with ' + count + (count === 1 ? ' headline.' : ' headlines.');
  } catch (error) {
    result = feedRequestError(error);
  }
  if (!editor.open || generation !== feedTestGeneration) return;
  feedTestStatus.textContent = result;
  testFeedButton.disabled = false;
};

get<HTMLFormElement>('feed-form').onsubmit = event => {
  event.preventDefault();
  const url = validatedFeedAddress();
  if (!url) return;
  const previous = draft[editingIndex];
  const address = previous && feedAddressKey(previous.url) === url ? previous.url : url;
  const feed = { name: feedName.value.trim() || new URL(url).hostname, url: address };
  const index = editingIndex < 0 ? draft.length : editingIndex;
  draft[index] = feed;
  draft.sort(compareFeedNames);
  const applyImmediately = contextAction === 'edit';
  contextAction = undefined;
  editor.close();
  renderSubscriptionList(draft.indexOf(feed));
  subscriptionList.focus();
  if (applyImmediately) saveSubscriptions();
};

deleteButton.onclick = () => {
  deletingIndex = subscriptionList.selectedIndex;
  get('delete-message').textContent = 'Delete “' + draft[deletingIndex].name + '” from your subscriptions?';
  deleteDialog.returnValue = '';
  deleteDialog.showModal();
};
editor.onclose = () => {
  resetFeedTest();
  if (contextAction === 'edit') {
    contextAction = undefined;
    subscriptionsDialog.close();
  } else if (subscriptionsDialog.open) {
    subscriptionList.focus();
  }
};
deleteDialog.onclose = () => {
  const applyImmediately = contextAction === 'delete';
  contextAction = undefined;
  if (deleteDialog.returnValue !== 'delete') {
    if (applyImmediately) subscriptionsDialog.close();
    else subscriptionList.focus();
    return;
  }
  draft.splice(deletingIndex, 1);
  renderSubscriptionList(deletingIndex);
  if (draft.length) subscriptionList.focus();
  else get('add-feed').focus();
  if (applyImmediately) saveSubscriptions();
};

function saveSubscriptions(): void {
  if (!subscriptionLoadWarning && draft.length === feeds.length && draft.every((feed, index) => feed.name === feeds[index].name && feed.url === feeds[index].url)) {
    subscriptionsDialog.close();
    return;
  }
  if (!persistSubscriptions(draft)) {
    subscriptionError.textContent = 'WinReader could not save your subscriptions.';
    subscriptionError.hidden = false;
    return;
  }
  subscriptionsDialog.close();
  applySubscriptions(draft);
}

function persistSubscriptions(next: Feed[]): boolean {
  try {
    if (damagedSubscriptions !== undefined) {
      localStorage.setItem('subscriptions-recovery', damagedSubscriptions);
    }
    localStorage.setItem('subscriptions', JSON.stringify(next));
  } catch {
    return false;
  }
  damagedSubscriptions = undefined;
  subscriptionLoadWarning = '';
  return true;
}

function applySubscriptions(next: Feed[]): void {
  feeds = next;
  const byUrl = new Map(feeds.map(feed => [feed.url, feed]));
  for (const [url, entries] of cache) {
    const feed = byUrl.get(url);
    if (feed) entries.forEach(entry => { entry.feed = feed; });
    else cache.delete(url);
  }
  for (const url of feedSnapshots.keys()) if (!byUrl.has(url)) feedSnapshots.delete(url);
  for (const url of failedFeeds.keys()) if (!byUrl.has(url)) failedFeeds.delete(url);
  for (const url of unsavedFeeds) if (!byUrl.has(url)) unsavedFeeds.delete(url);
  if (!byUrl.has(feedUrl)) feedUrl = '';
  if (selected && !byUrl.has(selected.feed.url)) selected = undefined;
  renderFeeds(feedsList.contains(document.activeElement));
  renderEntries();
  setStatus();
  void refresh();
}

get('save-subscriptions').onclick = saveSubscriptions;

interface OpmlImport {
  additions: Feed[];
  duplicates: number;
  invalid: number;
}

const maxOpmlBytes = 8 * 1024 * 1024;
const importDialog = get<HTMLDialogElement>('import-subscriptions-dialog');
const importFile = get<HTMLInputElement>('import-opml-file');
const importFileName = get<HTMLInputElement>('import-file-name');
const browseOpml = get<HTMLButtonElement>('browse-opml');
const confirmImport = get<HTMLButtonElement>('confirm-import');
const importSummary = get('import-summary');
const importError = get('import-error');
const closeImportLabel = get('close-import-label');
let importGeneration = 0;
let pendingImport: OpmlImport | undefined;

function decodeOpml(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const [first, second] = bytes;
  // XML can signal UTF-16 by its BOM or the byte order of the opening "<".
  if ((first === 0xff && second === 0xfe) || (first === 0x3c && second === 0)) {
    return new TextDecoder('utf-16le', { fatal: true }).decode(bytes);
  }
  if ((first === 0xfe && second === 0xff) || (first === 0 && second === 0x3c)) {
    return new TextDecoder('utf-16be', { fatal: true }).decode(bytes);
  }
  const header = new TextDecoder().decode(bytes.subarray(0, 1024));
  const declaration = header.match(/^<\?xml\s[^?]*\bencoding\s*=\s*["']([^"']+)["']/i);
  return new TextDecoder(declaration?.[1] ?? 'utf-8', { fatal: true }).decode(bytes);
}

function parseOpmlImport(raw: string, existing: Feed[]): OpmlImport {
  if (!raw.trim()) throw new Error('The selected file is empty.');
  let root: Element;
  try {
    root = parseXml(raw).documentElement;
  } catch {
    throw new Error('The selected file does not contain well-formed XML.');
  }
  const body = child(root, 'body');
  if (root.localName !== 'opml' || !body) {
    throw new Error('The selected file is not an OPML subscription export.');
  }
  const seen = new Set(existing.map(feed => feedAddressKey(feed.url)));
  const result: OpmlImport = { additions: [], duplicates: 0, invalid: 0 };
  for (const outline of body.getElementsByTagNameNS('*', 'outline')) {
    const address = outline.getAttribute('xmlUrl');
    const type = outline.getAttribute('type')?.trim().toLowerCase();
    if (address === null && type !== 'rss' && type !== 'atom') continue;
    const input = address?.trim() ?? '';
    const url = /^https?:\/\//i.test(input) ? feedAddressKey(input) : '';
    if (!url) {
      result.invalid++;
      continue;
    }
    const parsed = new URL(url);
    if (parsed.username || parsed.password) {
      result.invalid++;
      continue;
    }
    if (seen.has(url)) {
      result.duplicates++;
      continue;
    }
    seen.add(url);
    const name = outline.getAttribute('title')?.trim() || outline.getAttribute('text')?.trim() || parsed.hostname;
    result.additions.push({ name, url });
  }
  return result;
}

function describeImport(result: OpmlImport, imported = false): string {
  const count = result.additions.length;
  const summary = count
    ? imported ? count + (count === 1 ? ' subscription imported.' : ' subscriptions imported.')
      : count + (count === 1 ? ' new subscription ready to import.' : ' new subscriptions ready to import.')
    : 'No new subscriptions found.';
  const duplicates = result.duplicates ? ' Duplicates skipped: ' + result.duplicates + '.' : '';
  const invalid = result.invalid ? ' Entries with missing or unsupported feed URLs skipped: ' + result.invalid + '.' : '';
  return summary + duplicates + invalid;
}

function showImportSubscriptions(): void {
  importGeneration++;
  pendingImport = undefined;
  browseOpml.disabled = false;
  confirmImport.disabled = true;
  importFileName.value = '';
  importSummary.textContent = 'Choose an OPML export from your feed reader.';
  importError.hidden = true;
  closeImportLabel.textContent = 'Cancel';
  importDialog.showModal();
}

function showImportError(message: string): void {
  importError.textContent = message;
  importError.hidden = false;
}

browseOpml.onclick = () => {
  importFile.value = '';
  importFile.click();
};

importFile.onchange = async () => {
  const file = importFile.files?.[0];
  if (!file || !importDialog.open) return;
  const generation = ++importGeneration;
  pendingImport = undefined;
  confirmImport.disabled = true;
  importFileName.value = file.name;
  importSummary.textContent = '';
  importError.hidden = true;
  closeImportLabel.textContent = 'Cancel';
  if (file.size > maxOpmlBytes) {
    showImportError('The OPML file exceeds 8 MB. Choose a smaller export.');
    return;
  }
  importSummary.textContent = 'Reading OPML file…';
  let error = '';
  const bytes = await file.arrayBuffer().catch(() => null);
  if (!importDialog.open || generation !== importGeneration) return;
  if (bytes === null) {
    error = 'WinReader could not read the selected file.';
  } else {
    let raw: string | undefined;
    try {
      raw = decodeOpml(bytes);
    } catch {
      error = 'The selected file has an invalid or unsupported text encoding.';
    }
    if (raw !== undefined) {
      try {
        pendingImport = parseOpmlImport(raw, feeds);
      } catch (problem) {
        error = problem instanceof Error ? problem.message : 'WinReader could not read this OPML export.';
      }
    }
  }
  if (pendingImport) {
    importSummary.textContent = describeImport(pendingImport);
    confirmImport.disabled = !pendingImport.additions.length;
    if (!confirmImport.disabled) confirmImport.focus();
  } else {
    importSummary.textContent = '';
    showImportError(error);
  }
};

confirmImport.onclick = () => {
  const result = pendingImport;
  if (!result?.additions.length) return;
  const next = [...feeds, ...result.additions].sort(compareFeedNames);
  if (!persistSubscriptions(next)) {
    showImportError('WinReader could not save the imported subscriptions. Try again.');
    return;
  }
  pendingImport = undefined;
  importError.hidden = true;
  importSummary.textContent = describeImport(result, true);
  closeImportLabel.textContent = 'Close';
  closeImportLabel.closest('button')?.focus();
  confirmImport.disabled = true;
  applySubscriptions(next);
};

for (const dialog of document.querySelectorAll<HTMLDialogElement>('dialog')) {
  dialog.addEventListener('keydown', event => {
    if (event.key !== 'Enter' || event.defaultPrevented || (event.target as Element).closest('button, textarea')) return;
    const defaultButton = dialog.querySelector<HTMLButtonElement>('.default-button:enabled');
    if (!defaultButton) return;
    event.preventDefault();
    defaultButton.click();
  });
}

function isSavedFeed(value: unknown): value is Feed {
  if (!value || typeof value !== 'object') return false;
  const feed = value as Partial<Feed>;
  return typeof feed.name === 'string' && typeof feed.url === 'string' && Boolean(feedAddressKey(feed.url));
}

async function loadSubscriptions(): Promise<Feed[]> {
  let saved: string | null;
  try {
    saved = localStorage.getItem('subscriptions');
  } catch {
    subscriptionLoadWarning = 'Could not access saved subscriptions.';
    return [];
  }
  if (saved === null) {
    try {
      const opml = parseXml(await reader.readSubscriptions());
      return Array.from(opml.querySelectorAll('outline[xmlUrl]')).map(outline => ({
        name: outline.getAttribute('title') || outline.getAttribute('text') || 'Untitled feed',
        url: outline.getAttribute('xmlUrl')!.trim()
      })).filter(isSavedFeed);
    } catch {
      subscriptionLoadWarning = 'Could not load the starter subscriptions. Open Subscriptions to add a feed.';
      return [];
    }
  }
  let recovered: Feed[] = [];
  try {
    const stored: unknown = JSON.parse(saved);
    if (Array.isArray(stored)) {
      recovered = stored.filter(isSavedFeed);
      if (recovered.length === stored.length) return recovered;
    }
  } catch {
    // Retain unreadable data for recovery when a repaired list is saved.
  }
  damagedSubscriptions = saved;
  subscriptionLoadWarning = 'Some saved subscription data could not be read. Open Subscriptions to repair the list.';
  return recovered;
}

function isCachedFeed(snapshot: CachedFeed | null): snapshot is CachedFeed {
  return Boolean(snapshot && Number.isFinite(snapshot.checkedAt) &&
    typeof snapshot.validators?.etag === 'string' && typeof snapshot.validators.lastModified === 'string' &&
    Array.isArray(snapshot.entries) && snapshot.entries.every(entry => entry &&
      typeof entry.id === 'string' && typeof entry.title === 'string' && typeof entry.link === 'string' &&
      Number.isFinite(entry.date) && typeof entry.content?.text === 'string' &&
      typeof entry.content.html === 'string' && (entry.content.base === undefined || typeof entry.content.base === 'string')));
}

async function initialize(): Promise<void> {
  feeds = (await loadSubscriptions()).sort(compareFeedNames);
  await Promise.all(feeds.map(async feed => {
    const snapshot = await reader.readFeedCache(feed.url).catch(() => null);
    if (!isCachedFeed(snapshot)) return;
    feedSnapshots.set(feed.url, snapshot);
    cache.set(feed.url, snapshot.entries.map(entry => ({ ...entry, feed })));
  }));
  manageButton.disabled = false;
  initialized = true;
  renderFeeds();
  renderEntries();
  void refresh();
}
void initialize();
