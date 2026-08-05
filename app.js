// Main Application - Initializes and coordinates all modules

// Event Listeners
function initializeEventListeners() {
    // Collection selector
    document.getElementById('collectionSelect').addEventListener('change', (e) => {
        const collectionId = e.target.value;
        populateDatasets(collectionId);
    });

    // Dataset selector
    document.getElementById('datasetSelect').addEventListener('change', (e) => {
        const collectionId = document.getElementById('collectionSelect').value;
        const datasetId = e.target.value;
        populateDonors(collectionId, datasetId);
    });

    // Donor selector
    document.getElementById('donorSelect').addEventListener('change', (e) => {
        const collectionId = document.getElementById('collectionSelect').value;
        const datasetId = document.getElementById('datasetSelect').value;
        const donorId = e.target.value;
        updateView(collectionId, datasetId, donorId);
    });

    document.getElementById('cellMetricPrimaryBtn').addEventListener('click', () => switchCellMetric('composition'));
    document.getElementById('cellMetricSecondaryBtn').addEventListener('click', () => switchCellMetric('diversity'));
    document.getElementById('cellMetricTertiaryBtn').addEventListener('click', () => switchCellMetric('comparison'));
    document.getElementById('cellRangeTopBtn').addEventListener('click', () => switchCellRange('top'));
    document.getElementById('cellRangeOtherBtn').addEventListener('click', () => switchCellRange('other'));
    document.getElementById('cellRangeAllBtn').addEventListener('click', () => switchCellRange('all'));

    document.getElementById('regionMetricPrimaryBtn').addEventListener('click', () => switchRegionMetric('composition'));
    document.getElementById('regionMetricSecondaryBtn').addEventListener('click', () => switchRegionMetric('coverage'));
    document.getElementById('regionMetricTertiaryBtn').addEventListener('click', () => switchRegionMetric('comparison'));
    document.getElementById('regionRangeTopBtn').addEventListener('click', () => switchRegionRange('top'));
    document.getElementById('regionRangeOtherBtn').addEventListener('click', () => switchRegionRange('other'));
    document.getElementById('regionRangeAllBtn').addEventListener('click', () => switchRegionRange('all'));

    document.addEventListener('click', (event) => {
        const toggle = event.target.closest('.overview-toggle');
        if (!toggle) {
            return;
        }

        toggleOverviewExpansion(toggle.dataset.overview, toggle.dataset.section);
    });
}

// Atlas settings drawer: the atlas is embedded directly in the page, so its
// control panel is tucked into a collapsible drawer toggled from the section
// header. The atlas itself binds every control by element id, so relocating
// them into a drawer requires no atlas-side changes.
function initializeAtlasControls() {
    const section = document.getElementById('atlasSection');
    const toggle = document.getElementById('atlasSettingsToggle');
    if (!section || !toggle) {
        return;
    }

    let tourActive = false;

    function setOpen(open) {
        section.classList.toggle('show-settings', open);
        toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    }

    toggle.addEventListener('click', () => {
        setOpen(!section.classList.contains('show-settings'));
    });

    const closeButton = document.getElementById('atlasSettingsClose');
    if (closeButton) {
        closeButton.addEventListener('click', () => {
            setOpen(false);
            toggle.focus();
        });
    }

    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && section.classList.contains('show-settings')) {
            setOpen(false);
            toggle.focus();
        }
    });

    // One-time guided tour of the Atlas layer switch. The switch itself sits in
    // the section header, so the tour no longer has to coax anyone into opening
    // the settings drawer; it runs the first time the atlas actually scrolls into
    // view. Firing on page load instead would explain buttons that are still far
    // below the fold. State is remembered in localStorage so it never repeats.
    // The key is versioned: the tour moved and gained a fourth step, so readers
    // who saw the old drawer-anchored version should see this one once.
    const TOUR_KEY = 'digitalbrain.atlasLayerTourSeen.v2';
    const layerTabs = document.getElementById('dataLayerTabs');
    const tourSteps = layerTabs
        ? [
            {
                button: layerTabs.querySelector('[data-layer="cells"]'),
                title: 'Cell profiles',
                body: 'Show each region\u2019s cell-class composition as coloured markers on the 3D brain. Filter by cell class and minimum abundance.',
            },
            {
                button: layerTabs.querySelector('[data-layer="functional"]'),
                title: 'Functional connectivity',
                body: 'Switch to fMRI-derived functional links (FC) between regions. Adjust the connection threshold and label DMN nodes.',
            },
            {
                button: layerTabs.querySelector('[data-layer="structural"]'),
                title: 'Structural connectivity',
                body: 'Switch to structural links (SC) between regions, thresholded by within-matrix percentile.',
            },
            {
                button: layerTabs.querySelector('[data-layer="genes"]'),
                title: 'Gene expression',
                body: 'Colour the brain by one gene\u2019s mean expression or detection rate across regions. Search a gene, then pick a metric and an aggregation rule.',
            },
        ].filter((step) => step.button)
        : [];
    const tourEnabled = tourSteps.length === 4;

    let stepIndex = 0;
    let pop = null;

    function tourSeen() {
        try {
            return localStorage.getItem(TOUR_KEY) === '1';
        } catch (error) {
            return false;
        }
    }

    function markTourSeen() {
        try {
            localStorage.setItem(TOUR_KEY, '1');
        } catch (error) {
            /* storage may be unavailable; the tour just shows again next time */
        }
    }

    function buildPop() {
        pop = document.createElement('div');
        pop.className = 'atlas-tour-pop';
        pop.hidden = true;
        pop.setAttribute('role', 'dialog');
        pop.setAttribute('aria-label', 'Atlas layer guide');
        pop.innerHTML =
            '<span class="atlas-tour-arrow" aria-hidden="true"></span>' +
            '<span class="atlas-tour-step"></span>' +
            '<h4 class="atlas-tour-title"></h4>' +
            '<p class="atlas-tour-body"></p>' +
            '<div class="atlas-tour-actions">' +
            '<button type="button" class="atlas-tour-skip">Skip</button>' +
            '<div class="atlas-tour-nav">' +
            '<button type="button" class="atlas-tour-back">Back</button>' +
            '<button type="button" class="atlas-tour-next">Next</button>' +
            '</div></div>';
        document.body.appendChild(pop);
        pop.querySelector('.atlas-tour-skip').addEventListener('click', () => endTour(true));
        pop.querySelector('.atlas-tour-back').addEventListener('click', () => gotoStep(stepIndex - 1));
        pop.querySelector('.atlas-tour-next').addEventListener('click', () => {
            if (stepIndex >= tourSteps.length - 1) {
                endTour(true);
            } else {
                gotoStep(stepIndex + 1);
            }
        });
    }

    function positionPop(target) {
        const rect = target.getBoundingClientRect();
        const pw = pop.offsetWidth;
        const ph = pop.offsetHeight;
        const gap = 10;
        let top = rect.bottom + gap;
        let place = 'below';
        if (top + ph > window.innerHeight - 8) {
            top = rect.top - ph - gap;
            place = 'above';
        }
        const left = Math.min(Math.max(8, rect.left), window.innerWidth - pw - 8);
        pop.style.left = `${left}px`;
        pop.style.top = `${Math.max(8, top)}px`;
        pop.dataset.place = place;
        const arrowLeft = Math.min(Math.max(16, rect.left + rect.width / 2 - left), pw - 16);
        pop.style.setProperty('--arrow-left', `${arrowLeft}px`);
    }

    function renderStep() {
        const step = tourSteps[stepIndex];
        tourSteps.forEach((other) => other.button.classList.remove('atlas-tour-target'));
        step.button.classList.add('atlas-tour-target');
        pop.querySelector('.atlas-tour-step').textContent = `Step ${stepIndex + 1} of ${tourSteps.length}`;
        pop.querySelector('.atlas-tour-title').textContent = step.title;
        pop.querySelector('.atlas-tour-body').textContent = step.body;
        pop.querySelector('.atlas-tour-back').disabled = stepIndex === 0;
        pop.querySelector('.atlas-tour-next').textContent =
            stepIndex >= tourSteps.length - 1 ? 'Done' : 'Next';
        pop.hidden = false;
        positionPop(step.button);
    }

    function gotoStep(index) {
        stepIndex = Math.max(0, Math.min(tourSteps.length - 1, index));
        renderStep();
    }

    function reposition() {
        if (tourActive) {
            positionPop(tourSteps[stepIndex].button);
        }
    }

    function leaveTour() {
        endTour(true);
    }

    function startTour() {
        if (!tourEnabled || tourActive || tourSeen()) {
            return;
        }
        tourActive = true;
        if (!pop) {
            buildPop();
        }
        stepIndex = 0;
        renderStep();
        window.addEventListener('resize', reposition);
        window.addEventListener('scroll', reposition, true);
        window.addEventListener('hashchange', leaveTour);
    }

    function endTour(persist) {
        if (!tourActive) {
            return;
        }
        tourActive = false;
        window.removeEventListener('resize', reposition);
        window.removeEventListener('scroll', reposition, true);
        window.removeEventListener('hashchange', leaveTour);
        tourSteps.forEach((step) => step.button.classList.remove('atlas-tour-target'));
        if (pop) {
            pop.hidden = true;
        }
        if (persist) {
            markTourSeen();
        }
    }

    // Wait for the atlas to be on screen before explaining its controls. Without
    // IntersectionObserver we would have to guess; every browser this ships to has
    // it, so the fallback only covers test environments and is deliberately blunt.
    function watchForFirstView() {
        if (!tourEnabled || tourSeen()) {
            return;
        }
        if (typeof window.IntersectionObserver !== 'function') {
            window.setTimeout(startTour, 120);
            return;
        }
        const observer = new window.IntersectionObserver((entries) => {
            if (!entries.some((entry) => entry.isIntersecting)) {
                return;
            }
            observer.unobserve(section);
            // Let the layout settle so the popover anchors to a measured button.
            window.setTimeout(startTour, 120);
        }, { threshold: 0.25 });
        observer.observe(section);
    }

    watchForFirstView();
}

// Collapsible cell-type lists inside the embedded atlas. The atlas re-renders
// these lists (replacing their children) whenever the linked scope changes, so
// we watch the section for mutations and re-apply a "show 5 + fade" collapse
// with a click-to-expand toggle. Lives in the host app so the standalone atlas
// page keeps its original full lists.
function initializeAtlasListCollapse() {
    const section = document.getElementById('atlasSection');
    if (!section) {
        return;
    }

    const VISIBLE = 5;
    const listIds = ['cellTypeList', 'legendKey', 'compositionBars'];
    const toggles = new Map();
    let scheduled = false;

    function ensureToggle(list) {
        const existing = toggles.get(list);
        if (existing && existing.isConnected) {
            return existing;
        }
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'atlas-list-toggle';
        toggle.hidden = true;
        toggle.addEventListener('click', () => {
            list.dataset.expanded = list.dataset.expanded === 'true' ? 'false' : 'true';
            applyList(list, toggle);
        });
        list.insertAdjacentElement('afterend', toggle);
        toggles.set(list, toggle);
        return toggle;
    }

    function applyList(list, toggle) {
        // Guarded like every other write below: this observer watches #atlasSection for
        // class changes and this function runs inside it, so an unconditional write
        // re-triggers the observer even when the value is unchanged -- setting an
        // attribute to its current value still queues a mutation record. That fed a
        // schedule -> rAF -> applyAll -> schedule loop every frame for the life of
        // the page.
        if (!list.classList.contains('atlas-collapsible')) {
            list.classList.add('atlas-collapsible');
        }
        const rows = Array.from(list.children);
        if (rows.length <= VISIBLE) {
            if (!toggle.hidden) toggle.hidden = true;
            if (list.classList.contains('is-collapsed')) list.classList.remove('is-collapsed');
            if (list.style.maxHeight) list.style.maxHeight = '';
            return;
        }
        // Only measurable while the list is actually visible on screen.
        if (list.getBoundingClientRect().height === 0) {
            return;
        }
        if (toggle.hidden) toggle.hidden = false;
        if (list.dataset.expanded === 'true') {
            if (list.classList.contains('is-collapsed')) list.classList.remove('is-collapsed');
            const full = `${list.scrollHeight}px`;
            if (list.style.maxHeight !== full) list.style.maxHeight = full;
            if (toggle.textContent !== 'Show less') toggle.textContent = 'Show less';
        } else {
            if (!list.classList.contains('is-collapsed')) list.classList.add('is-collapsed');
            const anchor = rows[VISIBLE - 1];
            const cap = `${Math.round(anchor.getBoundingClientRect().bottom - list.getBoundingClientRect().top + 6)}px`;
            if (list.style.maxHeight !== cap) list.style.maxHeight = cap;
            const label = `Show all ${rows.length}`;
            if (toggle.textContent !== label) toggle.textContent = label;
        }
    }

    function applyAll() {
        listIds.forEach((id) => {
            const list = document.getElementById(id);
            if (list) {
                applyList(list, ensureToggle(list));
            }
        });
    }

    function schedule() {
        if (scheduled) {
            return;
        }
        scheduled = true;
        window.requestAnimationFrame(() => {
            scheduled = false;
            applyAll();
        });
    }

    const observer = new MutationObserver(schedule);
    observer.observe(section, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['hidden', 'class'],
    });
    schedule();
}

// Atlas-first view switch: the 3D atlas is the default content and a quiet
// icon+text toggle swaps the content region to the analytics overview. The
// current view is mirrored to the URL hash (#atlas / #overview) so it is
// shareable, bookmarkable, and survives browser back/forward and refresh.
function initializeViewSwitch() {
    const atlasView = document.getElementById('atlasSection');
    const overviewView = document.getElementById('overviewView');
    const atlasBtn = document.getElementById('viewAtlasBtn');
    const overviewBtn = document.getElementById('viewOverviewBtn');
    if (!atlasView || !overviewView || !atlasBtn || !overviewBtn) {
        return;
    }

    const HINT_KEY = 'digitalbrain.viewHintSeen';
    const hint = document.getElementById('viewHint');
    const hintDismiss = document.getElementById('viewHintDismiss');

    function dismissHint(persist) {
        if (hint && !hint.hidden) {
            hint.hidden = true;
        }
        if (persist) {
            try {
                localStorage.setItem(HINT_KEY, '1');
            } catch (error) {
                /* storage may be unavailable; the hint just shows again next time */
            }
        }
    }

    function viewFromHash() {
        return window.location.hash.replace('#', '') === 'overview' ? 'overview' : 'atlas';
    }

    function applyView(view) {
        const isOverview = view === 'overview';
        overviewView.classList.toggle('is-hidden', !isOverview);
        atlasView.classList.toggle('is-hidden', isOverview);
        overviewBtn.classList.toggle('is-active', isOverview);
        atlasBtn.classList.toggle('is-active', !isOverview);
        overviewBtn.setAttribute('aria-selected', isOverview ? 'true' : 'false');
        atlasBtn.setAttribute('aria-selected', isOverview ? 'false' : 'true');
        // The gene layer's scope lock only applies while the atlas is on screen;
        // the overview drives its charts from the same selects.
        if (window.AtlasBridge && typeof window.AtlasBridge.setAtlasViewVisible === 'function') {
            window.AtlasBridge.setAtlasViewVisible(!isOverview);
        }
        // Charts may have been drawn while the overview was hidden (0-sized);
        // refit them once it becomes visible.
        if (isOverview && typeof resizeAllCharts === 'function') {
            window.requestAnimationFrame(() => window.requestAnimationFrame(resizeAllCharts));
        }
    }

    // The hash is the single source of truth; clicks just update it. #atlas and
    // #overview match no element id, so the browser will not scroll-jump.
    atlasBtn.addEventListener('click', () => {
        dismissHint(true);
        window.location.hash = 'atlas';
    });
    overviewBtn.addEventListener('click', () => {
        dismissHint(true);
        window.location.hash = 'overview';
    });
    if (hintDismiss) {
        hintDismiss.addEventListener('click', () => dismissHint(true));
    }
    window.addEventListener('hashchange', () => applyView(viewFromHash()));

    applyView(viewFromHash());

    // One-time guide, shown only when landing on the default atlas view.
    let seen = false;
    try {
        seen = localStorage.getItem(HINT_KEY) === '1';
    } catch (error) {
        seen = false;
    }
    if (hint && !seen && viewFromHash() !== 'overview') {
        hint.hidden = false;
    }
}

// Initialize application
function initializeApp() {
    console.log('Initializing DigitalNeuron Explorer...');
    
    // Validate data structure
    if (!validateDataStructure(currentData)) {
        console.error('Invalid data structure');
        alert('Error: Invalid data structure. Please check the data format.');
        return;
    }

    // Populate initial dropdowns
    populateCollections();
    
    // Set up event listeners
    initializeEventListeners();
    initializeAtlasControls();
    initializeAtlasListCollapse();
    initializeStatusCapsuleMarquee();
    initializeViewSwitch();
    initializeGeneAtlas();
    
    // Show initial global aggregated state
    updateView('', '', '');
    
    console.log('DigitalNeuron Explorer initialized successfully');
}

// Status capsule in the atlas header row. The atlas rewrites its contents with
// innerHTML on every scope change, and in the cell-profiles layer the label grows
// with the selection ("Linked · <collection> · <dataset> · <donor>"). Left alone it
// widened the row until Atlas settings wrapped onto a second line. CSS caps the
// capsule; this decides whether what is left is worth scrolling and, if it is, wraps
// the text in a track for the transform animation to move. Pure CSS cannot decide it:
// no selector knows whether an element overflows.
function initializeStatusCapsuleMarquee() {
    const capsule = document.getElementById('datasetStatus');
    if (!capsule) {
        return;
    }

    // Constant speed while travelling, so a longer label scrolls for longer rather
    // than faster. Each travel leg is 38% of the cycle (the rest is the pauses written
    // into the keyframes), hence the division. The bounds stop a few pixels of overflow
    // from twitching and a very long one from crawling.
    const PIXELS_PER_SECOND = 45;
    const TRAVEL_FRACTION = 0.38;
    const MIN_CYCLE = 5;
    const MAX_CYCLE = 20;
    // Below this the window cannot be read even while scrolling, so the label is
    // dropped and its text moves to the capsule's tooltip. Dropping it can only make
    // the header row narrower, which is why it is safe: widening the label to fit the
    // text was tried and it brought the row wrapping back.
    const READABLE_WINDOW = 56;

    const stillness = window.matchMedia('(prefers-reduced-motion: reduce)');

    function labelOf(node) {
        return Array.from(node.children).find(
            (child) => child.tagName === 'SPAN' && !child.classList.contains('status-dot')
        );
    }

    // Every write below is conditional. sync() runs again on its own DOM edits (the
    // observer watches the node it edits) and dozens of times during a resize drag,
    // and re-adding is-marquee restarts the CSS animation -- so an unguarded write
    // would either loop forever or hold the text at the start of its travel.
    function setVar(node, name, value) {
        if (node.style.getPropertyValue(name) !== value) {
            node.style.setProperty(name, value);
        }
    }

    function setClass(node, name, on) {
        if (node.classList.contains(name) !== on) {
            node.classList.toggle(name, on);
        }
    }

    function setTitle(node, value) {
        if (value) {
            if (node.title !== value) {
                node.title = value;
            }
        } else if (node.hasAttribute('title')) {
            node.removeAttribute('title');
        }
    }

    function sync() {
        const label = labelOf(capsule);
        if (!label) {
            return;
        }
        const track = label.querySelector('.marquee-track');
        const text = label.textContent.trim();

        // A hidden label measures zero, so it has to come back before measuring.
        setClass(label, 'is-too-narrow', false);
        const room = label.clientWidth;
        // With a track in place, measure the track's own box: a transformed child
        // counts towards its parent's scrollable overflow, so label.scrollWidth would
        // drift with the animation, while offsetWidth is the untransformed width.
        const hidden = (track ? track.offsetWidth : label.scrollWidth) - room;

        const cramped = hidden > 1 && room < READABLE_WINDOW;
        const scrolling = hidden > 1 && !cramped && !stillness.matches;

        setClass(label, 'is-too-narrow', cramped);
        setTitle(capsule, cramped ? text : '');
        // Scrolling or merely truncated, the full text stays reachable on hover.
        setTitle(label, hidden > 1 && !cramped ? text : '');

        if (!scrolling) {
            if (track) {
                // Back to a plain text node so the CSS ellipsis has something to cut;
                // it would replace an inline-block track wholesale instead.
                label.textContent = text;
            }
            return;
        }

        const moving = track || label.appendChild(document.createElement('span'));
        if (!track) {
            moving.className = 'marquee-track';
            moving.textContent = text;
            // Drop the original text node, which is still sitting next to the track.
            while (moving.previousSibling) {
                label.removeChild(moving.previousSibling);
            }
        } else if (moving.textContent !== text) {
            moving.textContent = text;
        }

        const cycle = Math.min(
            MAX_CYCLE,
            Math.max(MIN_CYCLE, hidden / PIXELS_PER_SECOND / TRAVEL_FRACTION)
        );
        setVar(moving, '--marquee-shift', `${-hidden}px`);
        setVar(moving, '--marquee-duration', `${cycle.toFixed(1)}s`);
        setClass(moving, 'is-marquee', true);
    }

    // childList catches both the atlas's innerHTML rewrites and the track going in or
    // out; characterData covers in-place text edits. Re-measure on resize too, since
    // the cap is viewport-relative, and when the motion preference changes.
    new MutationObserver(sync).observe(capsule, {
        childList: true,
        characterData: true,
        subtree: true,
    });
    window.addEventListener('resize', sync);
    stillness.addEventListener('change', sync);
    sync();
}

// Wires the gene search row to the atlas. The index fetch is fire-and-forget: a
// build without the gene export just leaves the row disabled with a note, and the
// other three atlas layers keep working.
function initializeGeneAtlas() {
    if (!window.GeneAtlasView || !window.GeneAtlasData) return;
    window.GeneAtlasView.bootstrap({
        document,
        window,
        data: window.GeneAtlasData,
        atlas: window.DigitalBrainAtlas,
    });
}

// Cleanup on page unload
window.addEventListener('beforeunload', () => {
    destroyAllCharts();
});

// Error handling
window.addEventListener('error', (event) => {
    console.error('Application error:', event.error);
});

// Start the application when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeApp);
} else {
    initializeApp();
}

// Export functions to global scope for onclick handlers
window.switchRegionType = switchRegionType;
window.switchCellView = switchCellView;
window.switchCellMetric = switchCellMetric;
window.switchRegionMetric = switchRegionMetric;
window.switchCellRange = switchCellRange;
window.switchRegionRange = switchRegionRange;
