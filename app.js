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
        if (open) {
            maybeStartTour();
        } else if (tourActive) {
            endTour(true);
        }
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

    // One-time guided tour of the Atlas layer switch. It highlights each layer
    // button in turn and is triggered the first time the settings drawer opens;
    // a subtle pulse on the toggle invites that first open. State is remembered
    // in localStorage so it never repeats.
    const TOUR_KEY = 'digitalbrain.atlasLayerTourSeen';
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
        ].filter((step) => step.button)
        : [];
    const tourEnabled = tourSteps.length === 3;

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
        // The open click may have been undone before this fires.
        if (!section.classList.contains('show-settings')) {
            return;
        }
        tourActive = true;
        toggle.classList.remove('atlas-settings-pulse');
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
            toggle.classList.remove('atlas-settings-pulse');
        }
    }

    function maybeStartTour() {
        if (!tourEnabled || tourSeen()) {
            return;
        }
        // Start after the drawer's open animation so the target is laid out.
        window.setTimeout(startTour, 320);
    }

    if (tourEnabled && !tourSeen()) {
        toggle.classList.add('atlas-settings-pulse');
    }
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
        list.classList.add('atlas-collapsible');
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
    initializeViewSwitch();
    
    // Show initial global aggregated state
    updateView('', '', '');
    
    console.log('DigitalNeuron Explorer initialized successfully');
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
