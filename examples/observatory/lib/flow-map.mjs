const NS = 'http://www.w3.org/2000/svg';
const STAGES = [
  ['request', '01', 'Request', 'A synthetic attempt enters the recorded local decision path.'],
  ['ceiling', '02', 'Ceiling', 'The SDK compares known estimated spend plus the next estimate with the selected ceiling.'],
  ['reserve', '03', 'Reserve', 'The local demonstration ledger decides whether a unique operation ID can hold capacity.'],
  ['work', '04', 'Work', 'A synthetic callback runs only after a newly acquired hold.'],
  ['settle', '05', 'Settle', 'The SDK returns the recorded confirmation, release, refusal, or unresolved result.'],
];
const BRANCHES = [
  ['stop', 'Stopped', 'Cost or capacity refused, or a terminal ID skipped repeat work.'],
  ['release', 'Released', 'A definite local failure returned its hold.'],
  ['reconcile', 'Reconcile', 'An uncertain work outcome or failed confirmation kept its hold.'],
  ['confirmed', 'Confirmed', 'Known synthetic usage was confirmed by the local ledger.'],
];
const EDGE_KEYS = [
  ['entry', 'request'],
  ['request', 'ceiling'], ['ceiling', 'reserve'], ['reserve', 'work'],
  ['work', 'settle'], ['reserve', 'settle'], ['ceiling', 'stop'],
  ['settle', 'stop'], ['settle', 'release'], ['settle', 'reconcile'], ['settle', 'confirmed'],
];
const FINAL_BRANCH = {
  cost_denied: 'stop', denied: 'stop', operation_terminal: 'stop',
  released_after_failure: 'release', operation_in_progress: 'reconcile',
  work_outcome_ambiguous: 'reconcile', confirmation_failed: 'reconcile',
  release_failed: 'reconcile', confirmed: 'confirmed',
};

const layoutFor = (narrow) => narrow ? {
  size: [360, 440], cardWidth: 96,
  points: {
    entry: [8, 82],
    request: [62, 82], ceiling: [180, 82], reserve: [298, 82],
    work: [298, 222], settle: [180, 222],
    stop: [47, 360], release: [135, 360], reconcile: [225, 360], confirmed: [315, 360],
  },
} : {
  size: [1100, 500], cardWidth: 164,
  points: {
    entry: [10, 164],
    request: [110, 164], ceiling: [330, 164], reserve: [550, 164],
    work: [770, 164], settle: [990, 164],
    stop: [352, 379], release: [548, 379], reconcile: [746, 379], confirmed: [944, 379],
  },
};

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function svgElement(tag, className) {
  const node = document.createElementNS(NS, tag);
  if (className) node.setAttribute('class', className);
  return node;
}

function edgeSegment(layout, from, to) {
  const [sx, sy] = layout.points[from];
  const [tx, ty] = layout.points[to];
  if (from === 'reserve' && to === 'settle' && sy === ty) {
    return `C ${sx} ${sy + 200}, ${tx} ${ty + 200}, ${tx} ${ty}`;
  }
  if (sy === ty) {
    const bend = (sx + tx) / 2;
    return `C ${bend} ${sy}, ${bend} ${ty}, ${tx} ${ty}`;
  }
  const lift = Math.max(56, Math.min(105, Math.abs(ty - sy) * 0.53));
  return `C ${sx} ${sy + lift}, ${tx} ${ty - lift}, ${tx} ${ty}`;
}

function edgePath(layout, from, to) {
  const [sx, sy] = layout.points[from];
  return `M ${sx} ${sy} ${edgeSegment(layout, from, to)}`;
}

function motionPath(layout, event, previous, branch) {
  const sameAttempt = Boolean(previous && previous.attemptId === event.attemptId);
  if (!sameAttempt) return event.stage === 'request' ? edgePath(layout, 'entry', 'request') : null;
  if (previous.stage === event.stage) return null;
  const firstKey = `${previous.stage}-${event.stage}`;
  if (!EDGE_KEYS.some(([from, to]) => `${from}-${to}` === firstKey)) return null;
  let path = edgePath(layout, previous.stage, event.stage);
  if (branch) {
    // Only an observed refusal/settlement adds its exit wire. Reserve refusals
    // reach Settle on the bypass; they never pass through Work.
    const exitFrom = event.kind === 'cost_denied' ? 'ceiling' : 'settle';
    if (event.stage === exitFrom) path += ` ${edgeSegment(layout, exitFrom, branch)}`;
  }
  return path;
}

function branchFor(event) {
  if (!event) return null;
  if (event.kind === 'cost_denied') return 'stop';
  return event.stage === 'settle' ? FINAL_BRANCH[event.kind] ?? null : null;
}

function stagePosition(node, point, layout) {
  node.style.left = `${point[0] / layout.size[0] * 100}%`;
  node.style.top = `${point[1] / layout.size[1] * 100}%`;
}

/**
 * Render one already-recorded Threshold event prefix. No SDK call or timer is
 * started here; animation only travels across an event the caller has exposed.
 */
export function createFlowMap(host, { onSelect } = {}) {
  if (!(host instanceof HTMLElement)) throw new TypeError('Flow map host must be an HTML element.');
  const root = element('div', 'flow-map');
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', 'Recorded Threshold decision map');
  const backdrop = element('div', 'flow-map__backdrop');
  const eyebrow = element('div', 'flow-map__eyebrow');
  eyebrow.append(element('span', 'flow-map__eyebrow-mark'), element('span', '', 'RECORDED DECISION PATH'));
  const stageLayer = element('div', 'flow-map__nodes');
  const edgeSvg = svgElement('svg', 'flow-map__edges');
  const motionSvg = svgElement('svg', 'flow-map__motion');
  for (const svg of [edgeSvg, motionSvg]) {
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('preserveAspectRatio', 'none');
  }
  const pathNodes = new Map();
  const directions = new Map();
  for (const [from, to] of EDGE_KEYS) {
    const key = `${from}-${to}`;
    const path = svgElement('path', 'flow-map__edge');
    path.dataset.flowEdge = key;
    path.dataset.touched = 'false';
    path.dataset.active = 'false';
    edgeSvg.append(path);
    pathNodes.set(key, path);
    if (['request-ceiling', 'ceiling-reserve', 'reserve-work', 'work-settle'].includes(key)) {
      const direction = svgElement('path', 'flow-map__direction');
      direction.dataset.direction = key; direction.setAttribute('d', 'M -5 -4 L 2 0 L -5 4');
      edgeSvg.append(direction); directions.set(key, direction);
    }
  }
  const travelPath = svgElement('path', 'flow-map__travel-guide');
  motionSvg.append(travelPath);
  const particleGroup = svgElement('g', 'flow-map__particle');
  particleGroup.dataset.particle = '';
  const trails = [15, 8, 4].map((radius) => {
    const dot = svgElement('circle', 'flow-map__trail');
    dot.setAttribute('r', String(radius));
    particleGroup.append(dot);
    return dot;
  });
  const packet = svgElement('circle', 'flow-map__packet');
  packet.setAttribute('r', '5.5');
  particleGroup.append(packet);
  motionSvg.append(particleGroup);

  const stageNodes = new Map();
  let hovered = null;
  for (const [key, number, label, description] of STAGES) {
    const button = element('button', 'flow-map__node');
    button.type = 'button';
    button.dataset.flowNode = key;
    button.dataset.state = 'idle';
    button.setAttribute('aria-label', `Inspect ${label}: ${description}`);
    button.append(element('span', 'flow-map__node-index', number),
      element('span', 'flow-map__node-symbol'),
      element('span', 'flow-map__node-label', label));
    button.addEventListener('click', () => onSelect?.(key));
    button.addEventListener('mouseenter', () => { hovered = key; updateHint(); });
    button.addEventListener('mouseleave', () => { hovered = null; updateHint(); });
    button.addEventListener('focus', () => { hovered = key; updateHint(); });
    button.addEventListener('blur', () => { hovered = null; updateHint(); });
    stageLayer.append(button);
    stageNodes.set(key, button);
  }
  const branchNodes = new Map();
  for (const [key, label, description] of BRANCHES) {
    const branch = element('div', 'flow-map__branch');
    branch.dataset.flowNode = key;
    branch.dataset.state = 'idle';
    branch.tabIndex = 0;
    branch.setAttribute('role', 'note');
    branch.setAttribute('aria-label', `${label}: ${description}`);
    branch.append(element('span', 'flow-map__branch-glyph'), element('span', 'flow-map__branch-label', label));
    branch.addEventListener('mouseenter', () => { hovered = key; updateHint(); });
    branch.addEventListener('mouseleave', () => { hovered = null; updateHint(); });
    branch.addEventListener('focus', () => { hovered = key; updateHint(); });
    branch.addEventListener('blur', () => { hovered = null; updateHint(); });
    stageLayer.append(branch);
    branchNodes.set(key, branch);
  }
  const slots = element('div', 'flow-map__slots');
  slots.dataset.flowSlots = '';
  slots.setAttribute('aria-label', 'Local ledger capacity');
  stageLayer.append(slots);
  const legend = element('div', 'flow-map__legend');
  legend.append(element('span', '', '● recorded transition'), element('span', '', '○ available path'));
  const hint = element('div', 'flow-map__hint');
  hint.setAttribute('aria-live', 'off');
  const hintTitle = element('strong', 'flow-map__hint-title');
  const hintDetail = element('span', 'flow-map__hint-detail');
  hint.append(hintTitle, hintDetail);
  root.append(backdrop, edgeSvg, stageLayer, motionSvg, eyebrow, legend, hint);
  host.append(root);

  let lastOptions = null;
  let lastMotionKey = null;
  let raf = 0;
  let destroyed = false;
  let resizeObserver;
  let narrow = false;

  const stopAnimation = () => {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  };

  function updateHint() {
    const event = lastOptions?.event;
    const selected = hovered || lastOptions?.selectedStage;
    const info = STAGES.find(([key]) => key === selected) || BRANCHES.find(([key]) => key === selected);
    if (info && (hovered || selected !== event?.stage)) {
      hintTitle.textContent = info.length === 4 ? info[2] : info[1];
      hintDetail.textContent = info.length === 4 ? info[3] : info[2];
    } else if (event) {
      hintTitle.textContent = `EVENT ${event.sequence} · ${event.title}`;
      hintDetail.textContent = event.detail;
    } else {
      hintTitle.textContent = 'Follow a recorded decision';
      hintDetail.textContent = 'Choose a stage for its meaning, or run a synthetic local experiment to inspect its event path.';
    }
  }

  const placeParticle = (x, y, trail = false) => {
    packet.setAttribute('cx', String(x));
    packet.setAttribute('cy', String(y));
    trails.forEach((dot, index) => {
      dot.setAttribute('cx', String(x));
      dot.setAttribute('cy', String(y));
      dot.style.opacity = trail ? String(0.19 - index * 0.045) : '0';
    });
  };

  function render(options = {}) {
    if (destroyed) return;
    stopAnimation();
    const { session = null, cursor = 0, playing = false, selectedStage = null,
      reducedMotion = false, animate = true } = options;
    const quietMotion = reducedMotion || Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches);
    const safeCursor = session ? Math.max(0, Math.min(session.events.length, Math.trunc(cursor) || 0)) : 0;
    const prefix = session ? session.events.slice(0, safeCursor) : [];
    const event = prefix.at(-1) ?? null;
    const prior = prefix.at(-2) ?? null;
    const attemptPrefix = event ? prefix.filter((item) => item.attemptId === event.attemptId) : [];
    const branch = branchFor(event);
    const phaseTone = branch || ({
      outcome_ambiguous: 'reconcile', known_local_failure: 'release',
      denied: 'stop', operation_terminal: 'stop', operation_in_progress: 'reconcile',
    })[event?.kind] || 'none';
    const snapshot = event?.snapshot ?? session?.initial ?? null;
    const width = host.getBoundingClientRect().width || host.clientWidth || 1100;
    // Five wide placards and four exit plates need room; the compact graph
    // also covers tablet widths before desktop labels can collide.
    narrow = width < 900;
    const layout = layoutFor(narrow);
    root.classList.toggle('flow-map--narrow', narrow);
    root.classList.toggle('flow-map--reduced', quietMotion);
    root.dataset.outcome = phaseTone;
    root.dataset.stage = event?.stage || 'none';
    root.dataset.cursor = String(safeCursor);
    root.dataset.playing = String(Boolean(playing));
    edgeSvg.setAttribute('viewBox', `0 0 ${layout.size.join(' ')}`);
    motionSvg.setAttribute('viewBox', `0 0 ${layout.size.join(' ')}`);
    for (const [key, node] of stageNodes) {
      stagePosition(node, layout.points[key], layout);
      const visited = attemptPrefix.some((item) => item.stage === key);
      node.dataset.state = event?.stage === key ? 'current' : visited ? 'visited' : 'idle';
      node.dataset.selected = String(selectedStage === key);
      node.setAttribute('aria-pressed', String(selectedStage === key));
    }
    for (const [key, node] of branchNodes) {
      stagePosition(node, layout.points[key], layout);
      node.dataset.state = branch === key ? 'current' : 'idle';
      node.dataset.outcome = branch === key ? event.kind : 'none';
    }
    const [rx, ry] = layout.points.reserve;
    slots.style.left = `${(narrow ? layout.points.request[0] : rx) / layout.size[0] * 100}%`;
    slots.style.top = narrow ? `${layout.points.work[1] / layout.size[1] * 100}%` : `calc(${ry / layout.size[1] * 100}% + 81px)`;
    slots.replaceChildren();
    if (snapshot) {
      const limit = Math.max(0, Math.min(12, snapshot.capacityLimit));
      const unresolvedIds = new Set();
      for (const row of prefix) {
        if (['outcome_ambiguous', 'work_outcome_ambiguous', 'confirmation_failed', 'release_failed'].includes(row.kind)) unresolvedIds.add(row.operationId);
        else if (['confirmed', 'released_after_failure', 'acquired'].includes(row.kind)) unresolvedIds.delete(row.operationId);
      }
      const unresolved = Math.min(snapshot.held, unresolvedIds.size);
      slots.dataset.unresolved = String(unresolved);
      const label = element('span', 'flow-map__slots-label', narrow
        ? `${snapshot.confirmed + snapshot.held} / ${limit} occupied`
        : `${snapshot.confirmed} confirmed · ${snapshot.held} held / ${limit}`);
      const dots = element('span', 'flow-map__slots-dots');
      for (let index = 0; index < limit; index++) {
        const dot = element('i', 'flow-map__slot');
        dot.dataset.state = index < snapshot.confirmed ? 'confirmed' :
          index < snapshot.confirmed + snapshot.held - unresolved ? 'held' :
          index < snapshot.confirmed + snapshot.held ? 'unresolved' : 'open';
        dots.append(dot);
      }
      slots.append(dots, label);
      slots.setAttribute('aria-label', `${snapshot.confirmed} confirmed, ${snapshot.held} held, capacity ${limit}`);
    }

    const touched = new Set();
    for (let index = 1; index < attemptPrefix.length; index++) {
      const from = attemptPrefix[index - 1].stage;
      const to = attemptPrefix[index].stage;
      if (from !== to) touched.add(`${from}-${to}`);
    }
    if (event?.stage === 'request') touched.add('entry-request');
    if (branch) touched.add(event.kind === 'cost_denied' ? 'ceiling-stop' : `settle-${branch}`);
    const activeEdge = branch ? (event.kind === 'cost_denied' ? 'ceiling-stop' : `settle-${branch}`) :
      event?.stage === 'request' ? 'entry-request' :
      prior && event && prior.attemptId === event.attemptId && prior.stage !== event.stage
        ? `${prior.stage}-${event.stage}` : null;
    for (const [key, path] of pathNodes) {
      const [from, to] = key.split('-');
      path.setAttribute('d', edgePath(layout, from, to));
      const direction = directions.get(key);
      if (direction) {
        const length = path.getTotalLength(), point = path.getPointAtLength(length * .5);
        const next = path.getPointAtLength(length * .5 + 1);
        const angle = Math.atan2(next.y - point.y, next.x - point.x) * 180 / Math.PI;
        direction.setAttribute('transform', `translate(${point.x} ${point.y}) rotate(${angle})`);
        direction.dataset.active = String(key === activeEdge);
      }
      path.dataset.touched = String(touched.has(key));
      path.dataset.active = String(key === activeEdge);
      path.dataset.outcome = key === activeEdge && branch ? branch : 'none';
    }

    lastOptions = { ...options, event, cursor: safeCursor };
    updateHint();
    particleGroup.dataset.particle = event ? String(event.sequence) : '';
    if (!event) {
      particleGroup.style.opacity = '0';
      travelPath.setAttribute('d', '');
      lastMotionKey = null;
      return;
    }
    particleGroup.style.opacity = '1';
    particleGroup.dataset.outcome = branch || 'none';
    const [targetX, targetY] = layout.points[branch || event.stage];
    const route = motionPath(layout, event, prior, branch);
    travelPath.setAttribute('d', route || '');
    const motionKey = `${session.id}:${safeCursor}`;
    const shouldAnimate = Boolean(route && playing && animate && !quietMotion && motionKey !== lastMotionKey);
    lastMotionKey = motionKey;
    if (!shouldAnimate) {
      placeParticle(targetX, targetY);
      return;
    }
    const length = travelPath.getTotalLength();
    const began = performance.now();
    const duration = Math.min(480, Math.max(280, length * 1.25));
    const frame = (now) => {
      const fraction = Math.min(1, (now - began) / duration);
      const eased = 1 - Math.pow(1 - fraction, 3);
      const point = travelPath.getPointAtLength(length * eased);
      packet.setAttribute('cx', String(point.x));
      packet.setAttribute('cy', String(point.y));
      trails.forEach((dot, index) => {
        const behind = travelPath.getPointAtLength(Math.max(0, length * eased - (index + 1) * 18));
        dot.setAttribute('cx', String(behind.x));
        dot.setAttribute('cy', String(behind.y));
        dot.style.opacity = String((1 - fraction * 0.35) * (0.20 - index * 0.045));
      });
      if (fraction < 1) raf = requestAnimationFrame(frame);
      else { raf = 0; placeParticle(targetX, targetY); }
    };
    raf = requestAnimationFrame(frame);
  }

  const resize = () => {
    if (lastOptions && !destroyed) render({ ...lastOptions, animate: false });
  };
  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(host);
  } else {
    window.addEventListener('resize', resize);
  }

  return {
    render,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      stopAnimation();
      resizeObserver?.disconnect();
      if (!resizeObserver) window.removeEventListener('resize', resize);
      root.remove();
    },
  };
}
