(() => {
  "use strict";

  const source = window.DIGITALBRAIN_REGION_DATA;
  const anatomy = window.ALLEN_3D_ATLAS;
  const connectivity = window.DIGITALBRAIN_CONNECTIVITY_DATA;
  const knowledge = window.DIGITALBRAIN_ATLAS_KNOWLEDGE;
  if (
    !source?.regions?.length ||
    !anatomy?.labels?.length ||
    !connectivity?.nodes?.length ||
    !knowledge?.regions
  ) {
    const host = document.querySelector(".atlas-embed") || document.body;
    host.innerHTML =
      "<p>The region catalogue, Allen 3D anatomy, connectivity, or knowledge data could not be loaded.</p>";
    return;
  }

  const hashString = (str) => {
    let hash = 0;
    for (let i = 0; i < str.length; i += 1) {
      hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
    }
    return hash;
  };

  const hslToHex = (h, s, l) => {
    const sat = s / 100;
    const light = l / 100;
    const k = (n) => (n + h / 30) % 12;
    const a = sat * Math.min(light, 1 - light);
    const channel = (n) => {
      const value = light - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
      return Math.round(255 * value)
        .toString(16)
        .padStart(2, "0");
    };
    return `#${channel(0)}${channel(8)}${channel(4)}`;
  };

  // Curated colours for the atlas baseline classes; any other cell type name
  // gets a deterministic HSL-derived hex (stable across scopes). Returned as
  // hex so the existing blendColor()/parseHex() pipeline keeps working.
  const baseColors = {
    "Excitatory neuron": "#61ddb2",
    "Inhibitory neuron": "#8dc6f4",
    Astrocyte: "#f3c86f",
    Oligodendrocyte: "#a890ed",
    OPC: "#e995bb",
    Microglia: "#ef8e70",
    Endothelial: "#80c7ca",
  };
  const generatedColorCache = new Map();
  const colors = new Proxy(baseColors, {
    get(target, prop) {
      if (typeof prop !== "string" || prop in target) return target[prop];
      if (!generatedColorCache.has(prop)) {
        const hue = hashString(prop) % 360;
        const sat = 60 + (hashString(`${prop}::s`) % 20);
        const light = 58 + (hashString(`${prop}::l`) % 14);
        generatedColorCache.set(prop, hslToHex(hue, sat, light));
      }
      return generatedColorCache.get(prop);
    },
  });

  const groupColors = {
    "Cerebral cortex": "#5dd9b1",
    "Hippocampal formation": "#efb866",
    Thalamus: "#78b9ef",
    Hypothalamus: "#e98f9d",
    "Basal ganglia": "#a896ed",
    "Limbic / olfactory": "#e98bbf",
    Cerebellum: "#83c8ca",
    Brainstem: "#e98869",
    "Other subcortical": "#9fb4bb",
  };

  const ALL_CELL_TYPES = "__all__";

  const groupAnchors = {
    "Cerebral cortex": { x: 0, y: 0.16, z: 0, scale: 1 },
    "Hippocampal formation": { x: 0, y: -0.14, z: 0.12, scale: 0.46 },
    Thalamus: { x: 0, y: -0.02, z: -0.04, scale: 0.30 },
    "Basal ganglia": { x: 0, y: 0.01, z: 0.10, scale: 0.36 },
    "Limbic / olfactory": { x: 0, y: -0.05, z: 0.23, scale: 0.52 },
    Cerebellum: { x: 0, y: -0.47, z: -0.52, scale: 0.40 },
    Brainstem: { x: 0, y: -0.53, z: -0.17, scale: 0.26 },
    "Other subcortical": { x: 0, y: -0.08, z: -0.02, scale: 0.40 },
  };

  const state = {
    regions: structuredClone(source.regions),
    cellTypes: [...source.cellTypes],
    selectedCellType: ALL_CELL_TYPES,
    dataLayer: "cells",
    // Gene expression layer. An ordered array of
    // { symbol, colour, values: { acronym: value }, support: { acronym: cells }, byLabel }
    // -- ordered because the index fixes each gene's offset angle. A region absent from
    // a gene's table has no data and must never be drawn as a zero.
    genes: null,
    // The density calibration the values are to be read against. Never defaulted: it
    // ships with the data in index.json, so a missing one is a version mismatch.
    geneScale: null,
    geneMetric: "mean",
    geneRule: "cell_weighted",
    geneDetailProvider: null,
    anatomyStyle: "boundaries",
    connectivityPercentile: 96,
    selectedRegion: null,
    selectedConnection: null,
    functionFocus: null,
    showDmnLabels: true,
    selectedGroup: null,
    hoveredRegion: null,
    viewMode: "three-d",
    anatomyTiltX: -3,
    anatomyTiltY: 7,
    anatomyScale: 0.96,
    anatomyDragging: false,
    anatomyDragMoved: false,
    anatomyPointerStart: { x: 0, y: 0 },
    anatomyLastPointer: { x: 0, y: 0 },
    minimum: 0,
    showShell: true,
    showContours: true,
    autoRotate: false,
    rotationX: -0.05,
    rotationY: -0.72,
    targetRotationX: -0.05,
    targetRotationY: -0.72,
    zoom: 1,
    targetZoom: 1,
    dragging: false,
    dragMoved: false,
    pointerStart: { x: 0, y: 0 },
    lastPointer: { x: 0, y: 0 },
    regionProjection: [],
    dataStatus: source.metadata.compositionProvenance,
    importedRows: 0,
    importedRegionCount: 0,
    linkedActiveRegions: null,
    linkedRegionCells: null,
    linkedScopeLabel: null,
    linkedCellStats: null,
  };

  const dom = {
    canvas: document.getElementById("brainCanvas"),
    viewer: document.querySelector(".viewer-panel"),
    anatomyView: document.getElementById("anatomyView"),
    anatomyStage: document.getElementById("anatomyStage"),
    anatomySvg: document.getElementById("anatomySvg"),
    anatomyReset: document.getElementById("anatomyReset"),
    threeDViewTabs: document.getElementById("threeDViewTabs"),
    threeDViewerActions: document.getElementById("threeDViewerActions"),
    orientationCue: document.querySelector(".orientation-cue"),
    interactionHint: document.querySelector(".interaction-hint"),
    interactionHintText: document.getElementById("interactionHintText"),
    tooltip: document.getElementById("tooltip"),
    empty: document.getElementById("canvasEmpty"),
    cellTypeList: document.getElementById("cellTypeList"),
    abundance: document.getElementById("abundanceFilter"),
    abundanceValue: document.getElementById("abundanceValue"),
    abundanceSection: document.getElementById("abundanceSection"),
    abundanceFilterSection: document.getElementById("abundanceFilterSection"),
    atlasSearchSection: document.getElementById("atlasSearchSection"),
    connectivitySection: document.getElementById("connectivitySection"),
    connectivityFilter: document.getElementById("connectivityFilter"),
    connectivityValue: document.getElementById("connectivityValue"),
    dmnToggle: document.getElementById("dmnToggle"),
    dataLayerTabs: document.getElementById("dataLayerTabs"),
    anatomyStyleTabs: document.getElementById("anatomyStyleTabs"),
    search: document.getElementById("regionSearch"),
    searchResults: document.getElementById("searchResults"),
    shellToggle: document.getElementById("shellToggle"),
    rotateToggle: document.getElementById("rotateToggle"),
    legendSingle: document.getElementById("legendSingle"),
    legendAll: document.getElementById("legendAll"),
    legendConnectivity: document.getElementById("legendConnectivity"),
    connectivityLegendTitle: document.getElementById("connectivityLegendTitle"),
    connectivityLegendThreshold: document.getElementById("connectivityLegendThreshold"),
    connectivityLegendMinPercentile: document.getElementById("connectivityLegendMinPercentile"),
    connectivityLegendMinValue: document.getElementById("connectivityLegendMinValue"),
    connectivityLegendMaxValue: document.getElementById("connectivityLegendMaxValue"),
    connectivityEdgeCount: document.getElementById("connectivityEdgeCount"),
    visualKey: document.getElementById("visualKey"),
    mappingKey: document.getElementById("mappingKey"),
    legendKey: document.getElementById("legendKey"),
    legendTitle: document.getElementById("legendTitle"),
    legendRange: document.getElementById("legendRange"),
    visibleCount: document.getElementById("visibleCount"),
    cellTypeCount: document.getElementById("cellTypeCount"),
    secondaryCountLabel: document.getElementById("secondaryCountLabel"),
    detailPanel: document.querySelector(".detail-panel"),
    detailEmpty: document.getElementById("detailEmpty"),
    detailContent: document.getElementById("detailContent"),
    detailCode: document.getElementById("detailCode"),
    detailName: document.getElementById("detailName"),
    detailGroup: document.getElementById("detailGroup"),
    focusSwatch: document.getElementById("focusSwatch"),
    focusLabel: document.getElementById("focusLabel"),
    focusValue: document.getElementById("focusValue"),
    rankBadge: document.getElementById("rankBadge"),
    compositionBars: document.getElementById("compositionBars"),
    compositionSection: document.getElementById("compositionSection"),
    memberRegionsSection: document.getElementById("memberRegionsSection"),
    memberRegionsCount: document.getElementById("memberRegionsCount"),
    memberRegionList: document.getElementById("memberRegionList"),
    connectivityDetailSection: document.getElementById("connectivityDetailSection"),
    connectivityDetailTitle: document.getElementById("connectivityDetailTitle"),
    connectivityDetailUnit: document.getElementById("connectivityDetailUnit"),
    connectivityDetailList: document.getElementById("connectivityDetailList"),
    regionAnnotationSection: document.getElementById("regionAnnotationSection"),
    regionNetworkBadge: document.getElementById("regionNetworkBadge"),
    regionOverview: document.getElementById("regionOverview"),
    regionRole: document.getElementById("regionRole"),
    regionFunctionTags: document.getElementById("regionFunctionTags"),
    regionNetworkTags: document.getElementById("regionNetworkTags"),
    connectionInsightSection: document.getElementById("connectionInsightSection"),
    connectionInsightLayer: document.getElementById("connectionInsightLayer"),
    connectionPair: document.getElementById("connectionPair"),
    connectionWeightLabel: document.getElementById("connectionWeightLabel"),
    connectionWeight: document.getElementById("connectionWeight"),
    connectionPercentile: document.getElementById("connectionPercentile"),
    connectionExplanation: document.getElementById("connectionExplanation"),
    functionFocus: document.getElementById("functionFocus"),
    functionFocusLabel: document.getElementById("functionFocusLabel"),
    functionFocusSummary: document.getElementById("functionFocusSummary"),
    clearFunctionFocus: document.getElementById("clearFunctionFocus"),
    detailDataStatus: document.getElementById("detailDataStatus"),
    datasetStatus: document.getElementById("datasetStatus"),
    geometryStatus: document.getElementById("geometryStatus"),
    detailGeometryStatus: document.getElementById("detailGeometryStatus"),
    detailMappingBasis: document.getElementById("detailMappingBasis"),
    csvInput: document.getElementById("csvInput"),
    aboutDialog: document.getElementById("aboutDialog"),
    toast: document.getElementById("toast"),
  };

  const ctx = dom.canvas.getContext("2d", { alpha: true });
  let width = 1;
  let height = 1;
  let pixelRatio = 1;
  let lastFrame = performance.now();
  let toastTimer = null;
  const rotationCache = {
    x: Number.NaN,
    y: Number.NaN,
    cosineX: 1,
    sineX: 0,
    cosineY: 1,
    sineY: 0,
  };

  const voxelBounds = anatomy.metadata.nonzeroVoxelBounds;
  const voxelSize = anatomy.metadata.voxelSizeMm;
  const voxelOffset = anatomy.metadata.qoffsetMm;
  const physicalMinimum = voxelBounds.minimum.map(
    (value, axis) => voxelOffset[axis] + value * voxelSize[axis],
  );
  const physicalMaximum = voxelBounds.maximum.map(
    (value, axis) => voxelOffset[axis] + value * voxelSize[axis],
  );
  const physicalCenter = physicalMinimum.map(
    (value, axis) => (value + physicalMaximum[axis]) / 2,
  );
  const physicalScale = Math.max(
    ...physicalMinimum.map(
      (value, axis) => (physicalMaximum[axis] - value) / 2,
    ),
  );

  function voxelToPoint(voxel) {
    const physical = voxel.map(
      (value, axis) => voxelOffset[axis] + value * voxelSize[axis],
    );
    return {
      x: (physical[0] - physicalCenter[0]) / physicalScale,
      y: (physical[2] - physicalCenter[2]) / physicalScale,
      z: (physical[1] - physicalCenter[1]) / physicalScale,
    };
  }

  function decodeAtlasPointGroups(flatPoints) {
    const groups = Array.from({ length: anatomy.labels.length }, () => []);
    for (let index = 0; index < flatPoints.length; index += 4) {
      groups[flatPoints[index + 3]].push(
        voxelToPoint([
          flatPoints[index],
          flatPoints[index + 1],
          flatPoints[index + 2],
        ]),
      );
    }
    return groups;
  }

  const atlasOuterPointGroups = decodeAtlasPointGroups(anatomy.outerPoints);
  const atlasBoundaryPointGroups = decodeAtlasPointGroups(anatomy.boundaryPoints);
  const regionById = new Map(state.regions.map((region) => [region.id, region]));
  const connectivityNodeRegions = connectivity.nodes.map((node) => {
    const region = regionById.get(node.id);
    if (!region) throw new Error(`Connectivity region ${node.id} is absent.`);
    return region;
  });
  const connectivitySortedValues = {
    functional: connectivity.edges.map((edge) => edge[2]).sort((a, b) => a - b),
    structural: connectivity.edges.map((edge) => edge[3]).sort((a, b) => a - b),
  };
  const regionByAcronym = new Map(
    state.regions.map((region) => [region.acronym, region]),
  );
  // Snapshot of the illustrative baseline compositions so linked-scope overlays
  // can be applied and then cleanly reverted.
  const baseCompositions = new Map(
    state.regions.map((region) => [region.id, { ...region.composition }]),
  );
  const connectivityIndexById = new Map(
    connectivity.nodes.map((node, index) => [node.id, index]),
  );
  const dmnRegionIds = new Set(
    connectivityNodeRegions
      .filter((region) => knowledge.regions[region.acronym]?.dmn)
      .map((region) => region.id),
  );
  const spectrumStops = [
    [0, "#3b4cc0"],
    [0.2, "#1686d9"],
    [0.38, "#20c7c7"],
    [0.55, "#4dd66f"],
    [0.72, "#f0e442"],
    [0.86, "#f59f24"],
    [1, "#d7191c"],
  ];

  function hashUnit(text) {
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0) / 4294967295;
  }

  function ellipsoidPoint(theta, phi, hemisphere = 1, scale = 1) {
    const gap = 0.08;
    const sx = Math.sin(phi) * Math.cos(theta);
    const sy = Math.cos(phi);
    const sz = Math.sin(phi) * Math.sin(theta);
    const x = hemisphere * (gap + Math.abs(sx) * 0.94) * scale;
    return {
      x,
      y: sy * 0.78 * scale + 0.05,
      z: sz * 0.82 * scale,
    };
  }

  function stableAnchorFromPoints(points, seed) {
    if (!points.length) return null;
    const index = Math.min(
      points.length - 1,
      Math.floor(hashUnit(seed) * points.length),
    );
    return points[index];
  }

  function makeFixedRegionAnchors(region, mapping) {
    const outer = mapping.labelIndices.flatMap(
      (labelIndex) => atlasOuterPointGroups[labelIndex],
    );
    const boundary = mapping.labelIndices.flatMap(
      (labelIndex) => atlasBoundaryPointGroups[labelIndex],
    );
    const sourcePoints = outer.length ? outer : boundary;
    const anchors = [-1, 1]
      .map((hemisphere) => {
        const hemispherePoints = sourcePoints.filter((point) =>
          hemisphere < 0 ? point.x < -0.015 : point.x > 0.015,
        );
        return stableAnchorFromPoints(
          hemispherePoints,
          `${region.id}:fixed:${hemisphere}`,
        );
      })
      .filter(Boolean);
    if (!anchors.length) {
      const fallback = stableAnchorFromPoints(sourcePoints, `${region.id}:fixed:0`);
      if (fallback) anchors.push(fallback);
    }
    return anchors;
  }

  function assignRegionPositions() {
    for (const region of state.regions) {
      const mapping = anatomy.regionMappings[region.acronym] || {
        status: "unmapped",
        labelIndices: [],
        atlasAcronyms: [],
      };
      region.geometryMapping = mapping;
      region.hasAnatomy = mapping.labelIndices.length > 0;
      region.position = null;
      if (!region.hasAnatomy) continue;

      const mappedLabels = mapping.labelIndices.map(
        (labelIndex) => anatomy.labels[labelIndex],
      );
      const totalWeight = mappedLabels.reduce(
        (sum, label) => sum + label.boundaryVoxelCount,
        0,
      );
      const centroid = [0, 1, 2].map(
        (axis) =>
          mappedLabels.reduce(
            (sum, label) =>
              sum + label.centroidVoxel[axis] * label.boundaryVoxelCount,
            0,
          ) / totalWeight,
      );
      region.position = voxelToPoint(centroid);
      region.markerAnchors = makeFixedRegionAnchors(region, mapping);
      region.connectivityAnchor =
        region.markerAnchors.find((point) => point.x > 0.015) ||
        region.markerAnchors[0] ||
        region.position;
    }
  }

  function makeShellPoints() {
    const points = [];
    for (const hemisphere of [-1, 1]) {
      for (let p = 0; p < 18; p += 1) {
        const phi = 0.16 + (p / 17) * 2.78;
        for (let t = 0; t < 34; t += 1) {
          const theta = (t / 34) * Math.PI * 2;
          if (Math.cos(theta) * hemisphere < -0.86) continue;
          const point = ellipsoidPoint(theta, phi, hemisphere, 1);
          point.x *= 1 - 0.08 * Math.max(0, -point.z);
          point.y *= 1 - 0.06 * Math.max(0, -point.z);
          points.push({ ...point, kind: "cerebrum" });
        }
      }
    }

    for (let p = 0; p < 11; p += 1) {
      const phi = 0.24 + (p / 10) * 2.58;
      for (let t = 0; t < 28; t += 1) {
        const theta = (t / 28) * Math.PI * 2;
        points.push({
          x: Math.sin(phi) * Math.cos(theta) * 0.48,
          y: -0.48 + Math.cos(phi) * 0.33,
          z: -0.51 + Math.sin(phi) * Math.sin(theta) * 0.34,
          kind: "cerebellum",
        });
      }
    }

    for (let row = 0; row < 14; row += 1) {
      const y = -0.33 - row * 0.035;
      const radius = 0.17 - row * 0.004;
      for (let angle = 0; angle < Math.PI * 2; angle += Math.PI / 8) {
        points.push({
          x: Math.cos(angle) * radius,
          y,
          z: -0.18 + Math.sin(angle) * radius * 0.65,
          kind: "brainstem",
        });
      }
    }
    return points;
  }

  const shellPoints = makeShellPoints();

  function makeShellCurves() {
    const curves = [];
    for (const hemisphere of [-1, 1]) {
      for (let latitude = 1; latitude < 8; latitude += 1) {
        const phi = 0.24 + (latitude / 8) * 2.58;
        const points = [];
        for (let step = 0; step <= 44; step += 1) {
          const theta = (step / 44) * Math.PI * 2;
          const point = ellipsoidPoint(theta, phi, hemisphere, 1);
          point.x *= 1 - 0.08 * Math.max(0, -point.z);
          points.push(point);
        }
        curves.push(points);
      }

      for (let longitude = 0; longitude < 10; longitude += 1) {
        const theta = (longitude / 10) * Math.PI * 2;
        const points = [];
        for (let step = 0; step <= 34; step += 1) {
          const phi = 0.14 + (step / 34) * 2.86;
          const point = ellipsoidPoint(theta, phi, hemisphere, 1);
          point.x *= 1 - 0.08 * Math.max(0, -point.z);
          points.push(point);
        }
        curves.push(points);
      }
    }
    return curves;
  }

  const shellCurves = makeShellCurves();

  function rotate(point) {
    if (
      rotationCache.x !== state.rotationX ||
      rotationCache.y !== state.rotationY
    ) {
      rotationCache.x = state.rotationX;
      rotationCache.y = state.rotationY;
      rotationCache.cosineX = Math.cos(state.rotationX);
      rotationCache.sineX = Math.sin(state.rotationX);
      rotationCache.cosineY = Math.cos(state.rotationY);
      rotationCache.sineY = Math.sin(state.rotationY);
    }
    const cy = rotationCache.cosineY;
    const sy = rotationCache.sineY;
    const cx = rotationCache.cosineX;
    const sx = rotationCache.sineX;
    const x1 = point.x * cy - point.z * sy;
    const z1 = point.x * sy + point.z * cy;
    return {
      x: x1,
      y: point.y * cx - z1 * sx,
      z: point.y * sx + z1 * cx,
    };
  }

  function project(point) {
    const rotated = rotate(point);
    const baseScale = Math.min(width * 0.33, height * 0.44) * state.zoom;
    const depth = 3.1 + rotated.z;
    const perspective = 3.2 / depth;
    return {
      x: width * 0.5 + rotated.x * baseScale * perspective,
      y: height * 0.50 - rotated.y * baseScale * perspective,
      z: rotated.z,
      perspective,
    };
  }

  function parseHex(hex) {
    const value = hex.replace("#", "");
    return {
      r: parseInt(value.slice(0, 2), 16),
      g: parseInt(value.slice(2, 4), 16),
      b: parseInt(value.slice(4, 6), 16),
    };
  }

  function blendColor(lowHex, highHex, amount, alpha = 1) {
    const low = parseHex(lowHex);
    const high = parseHex(highHex);
    const t = Math.max(0, Math.min(1, amount));
    const r = Math.round(low.r + (high.r - low.r) * t);
    const g = Math.round(low.g + (high.g - low.g) * t);
    const b = Math.round(low.b + (high.b - low.b) * t);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  function spectrumColor(amount, alpha = 1) {
    const t = Math.max(0, Math.min(1, amount));
    const upperIndex = spectrumStops.findIndex(([position]) => position >= t);
    if (upperIndex <= 0) {
      return blendColor(spectrumStops[0][1], spectrumStops[0][1], 0, alpha);
    }
    const [upperPosition, upperColor] = spectrumStops[upperIndex];
    const [lowerPosition, lowerColor] = spectrumStops[upperIndex - 1];
    const local = (t - lowerPosition) / Math.max(0.0001, upperPosition - lowerPosition);
    return blendColor(lowerColor, upperColor, local, alpha);
  }

  function edgeKey(leftIndex, rightIndex) {
    return leftIndex < rightIndex
      ? `${leftIndex}:${rightIndex}`
      : `${rightIndex}:${leftIndex}`;
  }

  function valuePercentile(layer, value) {
    const values = connectivitySortedValues[layer];
    let low = 0;
    let high = values.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (values[middle] <= value) low = middle + 1;
      else high = middle;
    }
    return (low / values.length) * 100;
  }

  function spectrumPosition(percentile, thresholdPercentile = state.connectivityPercentile) {
    return (percentile - thresholdPercentile) / Math.max(1, 100 - thresholdPercentile);
  }

  function annotationFor(region) {
    return region ? knowledge.regions[region.acronym] || null : null;
  }

  function activeFunctionRegionIds() {
    if (!state.functionFocus) return new Set();
    return new Set(
      state.functionFocus.regions
        .map((acronym) => regionByAcronym.get(acronym)?.id)
        .filter(Boolean),
    );
  }

  function isAllCellTypes() {
    return state.selectedCellType === ALL_CELL_TYPES;
  }

  function dominantCellType(region) {
    return state.cellTypes
      .map((cellType) => ({
        cellType,
        value: region.composition[cellType] || 0,
      }))
      .sort((a, b) => b.value - a.value)[0];
  }

  function aggregateGroup(group) {
    const members = state.regions.filter((region) => region.group === group);
    const composition = Object.fromEntries(
      state.cellTypes.map((cellType) => [
        cellType,
        members.length
          ? members.reduce(
              (sum, region) => sum + (region.composition[cellType] || 0),
              0,
            ) / members.length
          : 0,
      ]),
    );
    const total = Object.values(composition).reduce((sum, value) => sum + value, 0);
    const normalized = Object.fromEntries(
      Object.entries(composition).map(([cellType, value]) => [
        cellType,
        total ? value / total : 0,
      ]),
    );
    return {
      id: `GROUP:${group}`,
      acronym: `${members.length} REGIONS`,
      name: group,
      group: "Schematic anatomical group",
      composition: normalized,
      isGroup: true,
      memberCount: members.length,
    };
  }

  function getVisibleRegions() {
    let anatomicallyMapped = state.regions.filter((region) => region.hasAnatomy);
    // The gene layer is global by construction: its data is a cross-study merge with
    // the dataset axis collapsed, so the Explorer's current selection does not apply.
    // Without this bypass the scope would silently crop the layer, which reads as
    // "the gene is not expressed here" when it is really a filter artefact.
    if (state.linkedActiveRegions && state.dataLayer !== "genes") {
      anatomicallyMapped = anatomicallyMapped.filter((region) =>
        state.linkedActiveRegions.has(region.acronym),
      );
    }
    if (state.dataLayer === "genes") {
      // Only regions carrying a value for the active gene are shown; the cell-class
      // threshold belongs to the composition layer and does not apply here.
      return anatomicallyMapped.filter((region) => geneValueFor(region) !== null);
    }
    if (isAllCellTypes()) return anatomicallyMapped;
    return anatomicallyMapped.filter(
      (region) => (region.composition[state.selectedCellType] || 0) >= state.minimum,
    );
  }

  // Value provider for the marker colour/radius channel. Returns null for "no data"
  // so callers can paint neutral grey and keep the region out of the colour range.
  //
  // Region-level and first-gene-only on purpose: this feeds the range readout and the
  // detail panel, which list one region at a time and so are unaffected by the
  // label-level merging the point cloud needs.
  function geneValueFor(region) {
    const gene = state.genes && state.genes[0];
    if (!gene) return null;
    const value = gene.values[region.acronym];
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }

  function getGeneRange() {
    const values = state.regions
      .filter((region) => region.hasAnatomy)
      .map((region) => geneValueFor(region))
      .filter((value) => value !== null);
    if (!values.length) return { min: null, max: null };
    return { min: Math.min(...values), max: Math.max(...values) };
  }

  function getRange() {
    if (state.dataLayer === "genes") {
      const range = getGeneRange();
      // Detection rate has a natural ceiling, so it keeps a fixed 0-100% scale to
      // stay comparable across genes; mean expression is unbounded and stretches.
      if (state.geneMetric === "detection") return { min: 0, max: 1 };
      return { min: range.min ?? 0, max: range.max ?? 0 };
    }
    const values = state.regions.filter((region) => region.hasAnatomy).map(
      (region) => region.composition[state.selectedCellType] || 0,
    );
    return {
      min: Math.min(...values),
      max: Math.max(...values),
    };
  }

  function labelIndicesForRegion(region) {
    return new Set(region?.geometryMapping?.labelIndices || []);
  }

  // Inverse of regionMappings: which DigitalBrain acronyms claim each Allen label.
  // Allen has one hippocampus-head label against ten DigitalBrain subregions, so the
  // point cloud's colouring unit has to be the label, not the region. Built once --
  // it is a property of the geometry, not of whichever genes are selected.
  const labelToRegions = (() => {
    const claims = new Map();
    Object.entries(anatomy.regionMappings).forEach(([acronym, mapping]) => {
      (mapping.labelIndices || []).forEach((labelIndex) => {
        if (!claims.has(labelIndex)) claims.set(labelIndex, []);
        claims.get(labelIndex).push(acronym);
      });
    });
    return claims;
  })();

  function atlasLabelStyles(boundaryLayer = false) {
    const selectedLabels = labelIndicesForRegion(state.selectedRegion);
    const hoveredLabels = labelIndicesForRegion(state.hoveredRegion);
    const allMode = isAllCellTypes();

    return anatomy.labels.map((label, labelIndex) => {
      const selected = selectedLabels.has(labelIndex);
      const hovered = hoveredLabels.has(labelIndex);
      let color = label.color;
      let alpha = boundaryLayer ? 0.56 : 0.3;

      if (selected || hovered) {
        const focusRegion = selected ? state.selectedRegion : state.hoveredRegion;
        const focusCell = allMode
          ? dominantCellType(focusRegion).cellType
          : state.selectedCellType;
        color = colors[focusCell] || "#e9fff8";
        alpha = selected ? 0.98 : 0.78;
      }
      return { color, alpha, selected, hovered };
    });
  }

  function drawAtlasPointGroups(pointGroups, boundaryLayer = false) {
    const styles = atlasLabelStyles(boundaryLayer);
    ctx.save();
    for (let labelIndex = 0; labelIndex < pointGroups.length; labelIndex += 1) {
      const points = pointGroups[labelIndex];
      if (!points.length) continue;
      const style = styles[labelIndex];
      const pointSize = style.selected
        ? 2.7
        : style.hovered
          ? 2.25
          : boundaryLayer
            ? 1.9
            : 1.65;
      ctx.fillStyle = style.color;
      ctx.globalAlpha = style.alpha;
      for (const point of points) {
        const projected = project(point);
        const size = Math.max(0.9, pointSize * projected.perspective);
        ctx.fillRect(
          projected.x - size / 2,
          projected.y - size / 2,
          size,
          size,
        );
      }
    }
    ctx.restore();
  }

  function atlasParcelProjectionGroups(labelIndex) {
    const outerPoints = atlasOuterPointGroups[labelIndex];
    const useOuterSurface = outerPoints.length >= 8;
    const sourcePoints = useOuterSurface
      ? outerPoints
      : atlasBoundaryPointGroups[labelIndex];
    const left = sourcePoints.filter((point) => point.x < -0.015);
    const right = sourcePoints.filter((point) => point.x > 0.015);
    const midline = sourcePoints.filter((point) => Math.abs(point.x) <= 0.015);
    const hemispheres = [left, right].filter((points) => points.length >= 3);
    if (!hemispheres.length && sourcePoints.length >= 3) {
      return [{ points: sourcePoints, useOuterSurface }];
    }
    if (midline.length >= 3) hemispheres.push(midline);
    return hemispheres.map((points) => ({ points, useOuterSurface }));
  }

  function polygonArea(points) {
    let area = 0;
    for (let index = 0; index < points.length; index += 1) {
      const current = points[index];
      const next = points[(index + 1) % points.length];
      area += current.x * next.y - next.x * current.y;
    }
    return Math.abs(area) / 2;
  }

  function drawAtlasParcelEnvelopes() {
    const selectedLabels = labelIndicesForRegion(state.selectedRegion);
    const hoveredLabels = labelIndicesForRegion(state.hoveredRegion);
    const parcels = [];
    anatomy.labels.forEach((label, labelIndex) => {
      atlasParcelProjectionGroups(labelIndex).forEach(
        ({ points, useOuterSurface }) => {
          const projected = points.map(project);
          const hull = convexHull(projected);
          if (hull.length < 3 || polygonArea(hull) < 5) return;
          parcels.push({
            label,
            labelIndex,
            hull,
            useOuterSurface,
            depth:
              projected.reduce((sum, point) => sum + point.z, 0) /
              projected.length,
          });
        },
      );
    });
    parcels.sort((left, right) => left.depth - right.depth);

    ctx.save();
    ctx.lineJoin = "round";
    for (const parcel of parcels) {
      const selected = selectedLabels.has(parcel.labelIndex);
      const hovered = hoveredLabels.has(parcel.labelIndex);
      const depth = Math.max(0, Math.min(1, (parcel.depth + 1.1) / 2.2));
      ctx.beginPath();
      ctx.moveTo(parcel.hull[0].x, parcel.hull[0].y);
      parcel.hull.slice(1).forEach((point) => ctx.lineTo(point.x, point.y));
      ctx.closePath();
      ctx.fillStyle = blendColor(
        parcel.label.color,
        "#071119",
        0.15,
        parcel.useOuterSurface ? 0.055 + depth * 0.06 : 0.018 + depth * 0.025,
      );
      ctx.fill();
      ctx.strokeStyle = blendColor(
        parcel.label.color,
        "#ffffff",
        0.42,
        selected ? 0.98 : hovered ? 0.82 : parcel.useOuterSurface ? 0.62 : 0.36,
      );
      ctx.lineWidth = selected ? 2.25 : hovered ? 1.65 : parcel.useOuterSurface ? 0.95 : 0.65;
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawSelectedParcelHalo() {
    const selectedLabels = state.selectedRegion?.geometryMapping?.labelIndices || [];
    if (!selectedLabels.length) return;
    const focusCell = isAllCellTypes()
      ? dominantCellType(state.selectedRegion).cellType
      : state.selectedCellType;
    const accent = colors[focusCell] || "#e9fff8";
    ctx.save();
    ctx.fillStyle = accent;
    ctx.shadowColor = accent;
    ctx.shadowBlur = 5;
    ctx.globalAlpha = 0.75;
    for (const labelIndex of selectedLabels) {
      for (const point of atlasBoundaryPointGroups[labelIndex]) {
        const projected = project(point);
        const size = Math.max(1.5, 2.15 * projected.perspective);
        ctx.fillRect(
          projected.x - size / 2,
          projected.y - size / 2,
          size,
          size,
        );
      }
    }
    ctx.restore();
  }

  function drawAtlasAnatomy() {
    drawAtlasPointGroups(atlasOuterPointGroups);
    if (state.showContours) drawAtlasPointGroups(atlasBoundaryPointGroups, true);
    if (state.showContours && state.anatomyStyle === "boundaries") {
      drawAtlasParcelEnvelopes();
    }
    drawSelectedParcelHalo();
  }

  function drawShell() {
    ctx.save();
    ctx.lineWidth = 0.55;
    for (const curve of shellCurves) {
      const projectedCurve = curve.map(project);
      const averageDepth =
        projectedCurve.reduce((sum, point) => sum + point.z, 0) / projectedCurve.length;
      const alpha = 0.025 + Math.max(0, (averageDepth + 1) / 2) * 0.07;
      ctx.strokeStyle = `rgba(89, 164, 147, ${alpha})`;
      ctx.beginPath();
      projectedCurve.forEach((point, index) => {
        if (index === 0) ctx.moveTo(point.x, point.y);
        else ctx.lineTo(point.x, point.y);
      });
      ctx.stroke();
    }
    ctx.restore();

    const projected = shellPoints
      .map((point) => ({ ...project(point), kind: point.kind }))
      .sort((a, b) => a.z - b.z);

    ctx.save();
    ctx.globalCompositeOperation = "screen";
    for (const point of projected) {
      const depth = (point.z + 1.2) / 2.4;
      const alpha = 0.035 + Math.max(0, depth) * 0.085;
      ctx.fillStyle =
        point.kind === "cerebellum"
          ? `rgba(96, 154, 141, ${alpha * 0.8})`
          : `rgba(104, 163, 153, ${alpha})`;
      ctx.beginPath();
      ctx.arc(point.x, point.y, 0.65 + point.perspective * 0.42, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  function drawConnectionLines(visibleRegions, projectedById) {
    const groups = new Map();
    for (const region of visibleRegions) {
      if (!groups.has(region.group)) groups.set(region.group, []);
      groups.get(region.group).push(region);
    }

    ctx.save();
    ctx.lineWidth = 0.45;
    for (const groupRegions of groups.values()) {
      for (let index = 1; index < groupRegions.length; index += 1) {
        const a = projectedById.get(groupRegions[index - 1].id);
        const b = projectedById.get(groupRegions[index].id);
        if (!a || !b) continue;
        const distance = Math.hypot(a.x - b.x, a.y - b.y);
        if (distance > Math.min(width, height) * 0.19) continue;
        ctx.strokeStyle = "rgba(76, 161, 143, 0.075)";
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  function convexHull(points) {
    if (points.length <= 2) return [...points];
    const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
    const cross = (origin, a, b) =>
      (a.x - origin.x) * (b.y - origin.y) - (a.y - origin.y) * (b.x - origin.x);
    const lower = [];
    for (const point of sorted) {
      while (lower.length >= 2 && cross(lower.at(-2), lower.at(-1), point) <= 0) {
        lower.pop();
      }
      lower.push(point);
    }
    const upper = [];
    for (const point of [...sorted].reverse()) {
      while (upper.length >= 2 && cross(upper.at(-2), upper.at(-1), point) <= 0) {
        upper.pop();
      }
      upper.push(point);
    }
    lower.pop();
    upper.pop();
    return [...lower, ...upper];
  }

  function drawRegionContours(projected) {
    const grouped = new Map();
    for (const item of projected) {
      if (!grouped.has(item.region.group)) grouped.set(item.region.group, []);
      grouped.get(item.region.group).push(item.projected);
    }

    const labelBoxes = [];
    ctx.save();
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 0.85;
    for (const [group, points] of grouped.entries()) {
      const color = groupColors[group] || "#9fb4bb";
      const centroid = {
        x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
        y: points.reduce((sum, point) => sum + point.y, 0) / points.length,
      };
      const hull = convexHull(points);
      const padded = hull.map((point) => {
        const dx = point.x - centroid.x;
        const dy = point.y - centroid.y;
        const distance = Math.max(1, Math.hypot(dx, dy));
        const padding = points.length < 4 ? 17 : 11;
        return {
          x: centroid.x + dx * ((distance + padding) / distance),
          y: centroid.y + dy * ((distance + padding) / distance),
        };
      });

      ctx.fillStyle = blendColor(color, "#061018", 0.15, 0.035);
      ctx.strokeStyle = blendColor(color, "#ffffff", 0.08, 0.34);
      ctx.beginPath();
      if (padded.length >= 3) {
        ctx.moveTo(padded[0].x, padded[0].y);
        padded.slice(1).forEach((point) => ctx.lineTo(point.x, point.y));
        ctx.closePath();
      } else {
        const radius = points.length === 1 ? 18 : Math.max(
          18,
          Math.hypot(points[0].x - points.at(-1).x, points[0].y - points.at(-1).y) / 2 + 12,
        );
        ctx.arc(centroid.x, centroid.y, radius, 0, Math.PI * 2);
      }
      ctx.fill();
      ctx.stroke();

      const top = Math.min(...padded.map((point) => point.y), centroid.y - 16);
      const label = group.toUpperCase();
      ctx.font = "600 7px Inter, ui-sans-serif, sans-serif";
      const labelWidth = ctx.measureText(label).width + 10;
      let labelX = Math.max(5, Math.min(width - labelWidth - 5, centroid.x - labelWidth / 2));
      let labelY = Math.max(48, top - 13);
      const overlaps = (box) =>
        labelBoxes.some(
          (placed) =>
            box.x < placed.x + placed.width &&
            box.x + box.width > placed.x &&
            box.y < placed.y + placed.height &&
            box.y + box.height > placed.y,
        );
      const box = { x: labelX, y: labelY, width: labelWidth, height: 13 };
      while (overlaps(box) && box.y < height - 40) {
        box.y += 14;
      }
      labelX = box.x;
      labelY = box.y;
      labelBoxes.push(box);
      ctx.setLineDash([]);
      ctx.fillStyle = "rgba(5, 14, 21, 0.82)";
      ctx.fillRect(labelX, labelY, labelWidth, 13);
      ctx.strokeStyle = blendColor(color, "#ffffff", 0.05, 0.26);
      ctx.strokeRect(labelX + 0.5, labelY + 0.5, labelWidth - 1, 12);
      ctx.fillStyle = blendColor(color, "#ffffff", 0.3, 0.82);
      ctx.fillText(label, labelX + 5, labelY + 9);
      ctx.setLineDash([4, 4]);
    }
    ctx.restore();
  }

  function drawCompositionGlyph(region, point, radius, alpha) {
    const total = state.cellTypes.reduce(
      (sum, cellType) => sum + (region.composition[cellType] || 0),
      0,
    );
    let start = -Math.PI / 2;
    ctx.save();
    ctx.globalAlpha = alpha;
    for (const cellType of state.cellTypes) {
      const value = region.composition[cellType] || 0;
      const end = start + (total ? (value / total) * Math.PI * 2 : 0);
      if (end > start) {
        ctx.fillStyle = colors[cellType] || "#9fb4bb";
        ctx.beginPath();
        ctx.moveTo(point.x, point.y);
        ctx.arc(point.x, point.y, radius, start, end);
        ctx.closePath();
        ctx.fill();
      }
      start = end;
    }
    ctx.globalAlpha = 1;
    ctx.fillStyle = "rgba(5, 14, 21, 0.72)";
    ctx.beginPath();
    ctx.arc(point.x, point.y, Math.max(1.2, radius * 0.23), 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function projectRegionMarkers(region) {
    const anchors = region.markerAnchors?.length
      ? region.markerAnchors
      : [region.position];
    return anchors.map(project);
  }

  function regionCanvasLabel(region) {
    if (
      state.dataLayer !== "cells" &&
      state.showDmnLabels &&
      dmnRegionIds.has(region.id)
    ) {
      return `DMN · ${region.acronym}`;
    }
    if (/\bPCC\b/.test(region.name)) return `${region.acronym} · PCC`;
    if (/\bMFC\b/.test(region.name)) return `${region.acronym} · MFC`;
    return region.acronym;
  }

  function drawRegionLabels(projected) {
    const placed = [];
    const labelledRegions = new Set();
    const functionIds = activeFunctionRegionIds();
    const maxLabels = Math.max(14, Math.min(32, Math.floor(width / 27)));
    const candidates = projected
      .filter((item) => (item.markerIndex || 0) === 0)
      .sort((left, right) => {
        const leftFocused =
          state.selectedRegion?.id === left.region.id ||
          state.hoveredRegion?.id === left.region.id;
        const rightFocused =
          state.selectedRegion?.id === right.region.id ||
          state.hoveredRegion?.id === right.region.id;
        if (leftFocused !== rightFocused) return leftFocused ? -1 : 1;
        const leftDmn =
          state.dataLayer !== "cells" && state.showDmnLabels && dmnRegionIds.has(left.region.id);
        const rightDmn =
          state.dataLayer !== "cells" && state.showDmnLabels && dmnRegionIds.has(right.region.id);
        if (leftDmn !== rightDmn) return leftDmn ? -1 : 1;
        const leftFunction = functionIds.has(left.region.id);
        const rightFunction = functionIds.has(right.region.id);
        if (leftFunction !== rightFunction) return leftFunction ? -1 : 1;
        return left.region.layoutIndex - right.region.layoutIndex;
      });
    let count = 0;
    ctx.save();
    ctx.font = "600 7px Inter, ui-sans-serif, sans-serif";
    for (const item of candidates) {
      const selected = state.selectedRegion?.id === item.region.id;
      const hovered = state.hoveredRegion?.id === item.region.id;
      const dmn =
        state.dataLayer !== "cells" &&
        state.showDmnLabels &&
        dmnRegionIds.has(item.region.id);
      const functionFocused = functionIds.has(item.region.id);
      const forced = selected || hovered || dmn || functionFocused;
      if (labelledRegions.has(item.region.id) && !selected && !hovered) continue;
      if (!forced && count >= maxLabels) continue;
      const label = regionCanvasLabel(item.region);
      const labelWidth = ctx.measureText(label).width + 6;
      const x = Math.max(4, Math.min(width - labelWidth - 4, item.projected.x + 7));
      let y = Math.max(45, Math.min(height - 18, item.projected.y - 9));
      let box = { x, y, width: labelWidth, height: 12 };
      const collides = (candidate) => placed.some(
        (other) =>
          candidate.x < other.x + other.width &&
          candidate.x + candidate.width > other.x &&
          candidate.y < other.y + other.height &&
          candidate.y + candidate.height > other.y,
      );
      if (collides(box) && forced) {
        const alternate = [-14, 14, -28, 28]
          .map((offset) => ({
            ...box,
            y: Math.max(45, Math.min(height - 18, y + offset)),
          }))
          .find((candidate) => !collides(candidate));
        if (alternate) {
          box = alternate;
          y = alternate.y;
        }
      }
      if (collides(box) && !forced) continue;
      placed.push(box);
      labelledRegions.add(item.region.id);
      count += 1;
      ctx.fillStyle = selected || hovered ? "rgba(6, 18, 25, 0.94)" : "rgba(6, 18, 25, 0.78)";
      ctx.fillRect(x, y, labelWidth, 12);
      ctx.fillStyle = selected || hovered
        ? "#e9fff8"
        : dmn
          ? "#d8baff"
          : functionFocused
            ? "#ffffff"
            : "rgba(177, 205, 205, 0.78)";
      ctx.fillText(label, x + 3, y + 8.5);
    }
    ctx.restore();
  }

  function updateAnatomySelection() {
    document.querySelectorAll(".anatomy-region").forEach((element) => {
      element.classList.toggle("selected", element.dataset.group === state.selectedGroup);
    });
  }

  function setAnatomyTransform() {
    dom.anatomySvg.style.setProperty("--anatomy-tilt-x", `${state.anatomyTiltX}deg`);
    dom.anatomySvg.style.setProperty("--anatomy-tilt-y", `${state.anatomyTiltY}deg`);
    dom.anatomySvg.style.setProperty("--anatomy-scale", String(state.anatomyScale));
  }

  function resetAnatomyTransform() {
    state.anatomyTiltX = -3;
    state.anatomyTiltY = 7;
    state.anatomyScale = 0.96;
    setAnatomyTransform();
  }

  function updateAnatomyMetrics() {
    const namespace = "http://www.w3.org/2000/svg";
    document.querySelectorAll(".anatomy-metric").forEach((metric) => {
      const aggregate = aggregateGroup(metric.dataset.metricGroup);
      metric.replaceChildren();

      const background = document.createElementNS(namespace, "circle");
      background.setAttribute("class", "anatomy-metric-bg");
      background.setAttribute("r", "16");
      metric.append(background);

      if (isAllCellTypes()) {
        const radius = 12.5;
        const circumference = 2 * Math.PI * radius;
        let offset = 0;
        for (const cellType of state.cellTypes) {
          const value = aggregate.composition[cellType] || 0;
          const segment = document.createElementNS(namespace, "circle");
          segment.setAttribute("class", "anatomy-metric-segment");
          segment.setAttribute("r", String(radius));
          segment.setAttribute("stroke", colors[cellType] || "#9fb4bb");
          segment.setAttribute(
            "stroke-dasharray",
            `${value * circumference} ${circumference}`,
          );
          segment.setAttribute("stroke-dashoffset", String(-offset * circumference));
          segment.setAttribute("transform", "rotate(-90)");
          metric.append(segment);
          offset += value;
        }
      } else {
        const value = aggregate.composition[state.selectedCellType] || 0;
        const fill = document.createElementNS(namespace, "circle");
        fill.setAttribute("r", "12.5");
        fill.setAttribute("fill", colors[state.selectedCellType] || "#9fb4bb");
        fill.setAttribute("fill-opacity", String(0.24 + value * 0.76));
        metric.append(fill);
      }

      const valueLabel = document.createElementNS(namespace, "text");
      valueLabel.setAttribute("class", "anatomy-metric-value");
      valueLabel.setAttribute("y", "0.5");
      valueLabel.textContent = isAllCellTypes()
        ? String(aggregate.memberCount)
        : String(Math.round((aggregate.composition[state.selectedCellType] || 0) * 100));
      metric.append(valueLabel);
    });
  }

  function selectAnatomyGroup(group) {
    state.selectedGroup = group;
    const aggregate = aggregateGroup(group);
    state.selectedRegion = aggregate;
    updateAnatomySelection();
    updateDetail(aggregate);
  }

  function showAnatomyTooltip(group, event) {
    const aggregate = aggregateGroup(group);
    const focus = isAllCellTypes()
      ? dominantCellType(aggregate)
      : {
          cellType: state.selectedCellType,
          value: aggregate.composition[state.selectedCellType] || 0,
        };
    const rect = dom.viewer.getBoundingClientRect();
    const point = {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    };
    dom.tooltip.innerHTML = `<strong>${group}</strong><span>${aggregate.memberCount} regions · ${
      isAllCellTypes() ? "dominant " : ""
    }${focus.cellType}: ${formatPercent(focus.value)}</span>`;
    dom.tooltip.style.left = `${Math.min(width - 230, point.x)}px`;
    dom.tooltip.style.top = `${Math.max(55, Math.min(height - 55, point.y))}px`;
    dom.tooltip.hidden = false;
  }

  function setVisualizationMode(mode) {
    const anatomyMode = mode === "anatomy";
    state.viewMode = anatomyMode ? "anatomy" : "three-d";
    dom.anatomyView.hidden = !anatomyMode;
    dom.canvas.hidden = anatomyMode;
    dom.threeDViewTabs.hidden = anatomyMode;
    dom.threeDViewerActions.hidden = anatomyMode;
    dom.orientationCue.hidden = anatomyMode;
    dom.interactionHint.hidden = anatomyMode;
    dom.empty.hidden = anatomyMode || getVisibleRegions().length > 0;
    dom.viewer.classList.toggle("anatomy-mode", anatomyMode);
    document.querySelectorAll("[data-mode]").forEach((button) => {
      button.classList.toggle("active", button.dataset.mode === state.viewMode);
    });
    dom.tooltip.hidden = true;
    if (anatomyMode) updateAnatomyMetrics();
    else resizeCanvas();
  }

  function drawRegions() {
    const visibleRegions = getVisibleRegions();
    dom.empty.hidden = visibleRegions.length > 0;
    dom.visibleCount.textContent = String(visibleRegions.length);
    dom.cellTypeCount.textContent = String(state.cellTypes.length);
    dom.secondaryCountLabel.textContent = "cell classes";

    const allMode = isAllCellTypes();
    const geneMode = state.dataLayer === "genes";
    const { min, max } = allMode && !geneMode ? { min: 0, max: 1 } : getRange();
    if (geneMode) {
      dom.legendRange.textContent =
        state.geneMetric === "detection"
          ? "0–100%"
          : `${min.toFixed(2)}–${max.toFixed(2)}`;
    } else if (!allMode) {
      dom.legendRange.textContent = `${Math.round(min * 100)}–${Math.round(max * 100)}%`;
    }
    const projected = visibleRegions
      .flatMap((region) =>
        projectRegionMarkers(region).map((marker, markerIndex) => ({
          region,
          projected: marker,
          markerIndex,
        })),
      )
      .sort((a, b) => a.projected.z - b.projected.z);

    state.regionProjection = [];

    const linkedCells = state.linkedActiveRegions ? state.linkedRegionCells || {} : null;
    const maxLinkedCount = linkedCells
      ? Math.max(1, ...visibleRegions.map((region) => linkedCells[region.acronym] || 0))
      : 1;

    for (const item of projected) {
      const { region, projected: point } = item;
      const dominant = dominantCellType(region);
      const geneValue = geneMode ? geneValueFor(region) : null;
      const value = geneMode
        ? geneValue
        : allMode
          ? dominant.value
          : region.composition[state.selectedCellType] || 0;
      let normalized = geneMode
        ? max === min
          ? 0.5
          : (value - min) / (max - min)
        : allMode
          ? 0.62
          : max === min
            ? 0.5
            : (value - min) / (max - min);
      if (linkedCells && !geneMode) {
        const count = linkedCells[region.acronym] || 0;
        normalized = maxLinkedCount > 0 ? Math.sqrt(count) / Math.sqrt(maxLinkedCount) : 0.5;
      }
      const selected = state.selectedRegion?.id === region.id;
      const hovered = state.hoveredRegion?.id === region.id;
      const radius =
        (geneMode
          ? 3.2 + normalized * 5
          : allMode
            ? linkedCells
              ? 3.2 + normalized * 5
              : 5.4
            : 2.8 + normalized * 4.2) * Math.max(0.72, point.perspective);
      const accent = colors[allMode ? dominant.cellType : state.selectedCellType] || "#61ddb2";
      const alpha = allMode ? 0.82 : 0.42 + normalized * 0.55;

      if (selected || hovered) {
        const glow = ctx.createRadialGradient(
          point.x,
          point.y,
          radius * 0.4,
          point.x,
          point.y,
          radius * 3.7,
        );
        glow.addColorStop(0, blendColor(accent, "#ffffff", 0.2, selected ? 0.36 : 0.25));
        glow.addColorStop(1, blendColor(accent, "#ffffff", 0.2, 0));
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(point.x, point.y, radius * 3.7, 0, Math.PI * 2);
        ctx.fill();
      }

      if (allMode) {
        drawCompositionGlyph(region, point, radius, alpha);
      } else {
        ctx.fillStyle = blendColor("#25414a", accent, 0.25 + normalized * 0.75, alpha);
        ctx.beginPath();
        ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.beginPath();
      ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
      ctx.setLineDash(
        region.geometryMapping?.status === "recoverable_exact_or_union"
          ? []
          : [2.2, 2.2],
      );
      ctx.strokeStyle = selected
        ? "rgba(237, 255, 249, 0.95)"
        : blendColor(accent, "#ffffff", 0.38, 0.3 + normalized * 0.42);
      ctx.lineWidth = selected ? 1.8 : 0.75;
      ctx.stroke();
      ctx.setLineDash([]);

      if (selected) {
        ctx.strokeStyle = blendColor(accent, "#ffffff", 0.15, 0.42);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(point.x, point.y, radius + 5.5, 0, Math.PI * 2);
        ctx.stroke();
      }

      state.regionProjection.push({
        region,
        x: point.x,
        y: point.y,
        z: point.z,
        radius: Math.max(8, radius + 4),
      });
    }
    if (state.showContours) drawRegionLabels(projected);
  }

  function connectivityConfig(layer = state.dataLayer) {
    return layer === "structural"
      ? {
          metricIndex: 3,
          title: "Structural connectivity",
          shortLabel: "SC",
          color: "#78b9ef",
        }
      : {
          metricIndex: 2,
          title: "Functional connectivity",
          shortLabel: "FC",
          color: "#f0a36a",
        };
  }

  function functionFocusEdgeKeys(layer = state.dataLayer) {
    const regionIds = activeFunctionRegionIds();
    if (!regionIds.size || !["functional", "structural"].includes(layer)) return new Set();
    const config = connectivityConfig(layer);
    return new Set(
      connectivity.edges
        .map((edge) => ({
          sourceIndex: edge[0],
          targetIndex: edge[1],
          value: edge[config.metricIndex],
          key: edgeKey(edge[0], edge[1]),
        }))
        .filter(
          (edge) =>
            regionIds.has(connectivityNodeRegions[edge.sourceIndex].id) &&
            regionIds.has(connectivityNodeRegions[edge.targetIndex].id),
        )
        .sort((left, right) => right.value - left.value)
        .slice(0, 12)
        .map((edge) => edge.key),
    );
  }

  function sortedQuantile(values, percentile) {
    const position = (values.length - 1) * (percentile / 100);
    const lower = Math.floor(position);
    const upper = Math.min(values.length - 1, lower + 1);
    const fraction = position - lower;
    return values[lower] * (1 - fraction) + values[upper] * fraction;
  }

  function getVisibleConnectivityEdges() {
    const config = connectivityConfig();
    const values = connectivitySortedValues[state.dataLayer];
    const threshold = sortedQuantile(values, state.connectivityPercentile);
    const focusedEdgeKeys = functionFocusEdgeKeys();
    const edges = connectivity.edges
      .map((edge) => ({
        sourceIndex: edge[0],
        targetIndex: edge[1],
        value: edge[config.metricIndex],
        percentile: valuePercentile(state.dataLayer, edge[config.metricIndex]),
        key: edgeKey(edge[0], edge[1]),
      }))
      .filter(
        (edge) =>
          edge.value >= threshold ||
          focusedEdgeKeys.has(edge.key) ||
          (state.selectedConnection?.layer === state.dataLayer &&
            state.selectedConnection.key === edge.key),
      )
      .map((edge) => ({
        ...edge,
        functionFocused: focusedEdgeKeys.has(edge.key),
        selected:
          state.selectedConnection?.layer === state.dataLayer &&
          state.selectedConnection.key === edge.key,
      }))
      .sort((left, right) => left.value - right.value);
    return {
      config,
      threshold,
      edges,
      values,
    };
  }

  function drawConnectivity() {
    dom.empty.hidden = true;
    const nodes = connectivityNodeRegions.map((region, nodeIndex) => {
      const projected = project(region.connectivityAnchor || region.position);
      return { nodeIndex, region, projected };
    });
    const { config, edges, threshold, values } = getVisibleConnectivityEdges();
    const selectedNodeIndex = state.selectedRegion
      ? connectivity.nodes.findIndex((node) => node.id === state.selectedRegion.id)
      : -1;
    const degree = new Map();

    ctx.save();
    if (state.dataLayer === "structural") ctx.setLineDash([3, 2]);
    for (const edge of edges) {
      const sourceNode = nodes[edge.sourceIndex];
      const targetNode = nodes[edge.targetIndex];
      if (!sourceNode || !targetNode) continue;
      degree.set(edge.sourceIndex, (degree.get(edge.sourceIndex) || 0) + 1);
      degree.set(edge.targetIndex, (degree.get(edge.targetIndex) || 0) + 1);
      const normalized = spectrumPosition(edge.percentile);
      const incident =
        selectedNodeIndex < 0 ||
        edge.sourceIndex === selectedNodeIndex ||
        edge.targetIndex === selectedNodeIndex;
      const alpha = selectedNodeIndex < 0
        ? 0.72
        : incident
          ? 0.92
          : 0.24;
      const start = sourceNode.projected;
      const end = targetNode.projected;
      const dx = end.x - start.x;
      const dy = end.y - start.y;
      const distance = Math.max(1, Math.hypot(dx, dy));
      const direction =
        hashUnit(`${sourceNode.region.id}:${targetNode.region.id}:${state.dataLayer}`) > 0.5
          ? 1
          : -1;
      const curve = Math.min(24, distance * 0.08) * direction;
      const controlX = (start.x + end.x) / 2 - (dy / distance) * curve;
      const controlY = (start.y + end.y) / 2 + (dx / distance) * curve;
      if (edge.selected || edge.functionFocused) {
        ctx.save();
        ctx.setLineDash([]);
        ctx.strokeStyle = edge.selected
          ? "rgba(255,255,255,0.92)"
          : "rgba(255,255,255,0.48)";
        ctx.lineWidth = edge.selected ? 5.2 : 3.4;
        ctx.beginPath();
        ctx.moveTo(start.x, start.y);
        ctx.quadraticCurveTo(controlX, controlY, end.x, end.y);
        ctx.stroke();
        ctx.restore();
      }
      ctx.strokeStyle = spectrumColor(normalized, alpha);
      ctx.lineWidth = edge.selected
        ? 3.1
        : edge.functionFocused
          ? 2.45
          : incident
            ? 1.15 + Math.max(0, normalized) * 1.25
            : 0.75;
      ctx.beginPath();
      ctx.moveTo(start.x, start.y);
      ctx.quadraticCurveTo(controlX, controlY, end.x, end.y);
      ctx.stroke();
    }
    ctx.restore();

    state.regionProjection = [];
    const projectedForLabels = [];
    const functionRegionIds = activeFunctionRegionIds();
    for (const node of nodes.sort((left, right) => left.projected.z - right.projected.z)) {
      const selected = state.selectedRegion?.id === node.region.id;
      const hovered = state.hoveredRegion?.id === node.region.id;
      const nodeDegree = degree.get(node.nodeIndex) || 0;
      const dmn = state.showDmnLabels && dmnRegionIds.has(node.region.id);
      const functionFocused = functionRegionIds.has(node.region.id);
      const radius =
        (3.3 + Math.min(2.3, nodeDegree * 0.12)) *
        Math.max(0.75, node.projected.perspective);
      ctx.fillStyle = selected
        ? "#eafff8"
        : blendColor("#172d35", config.color, 0.7, hovered ? 0.98 : 0.8);
      ctx.beginPath();
      ctx.arc(node.projected.x, node.projected.y, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = selected
        ? config.color
        : blendColor(config.color, "#ffffff", 0.28, 0.86);
      ctx.lineWidth = selected ? 2 : 0.85;
      ctx.stroke();
      if (dmn || functionFocused) {
        ctx.strokeStyle = functionFocused ? "rgba(255,255,255,0.92)" : "#c79aff";
        ctx.lineWidth = functionFocused ? 2.1 : 1.6;
        ctx.beginPath();
        ctx.arc(node.projected.x, node.projected.y, radius + 3.2, 0, Math.PI * 2);
        ctx.stroke();
      }
      if (selected) {
        ctx.strokeStyle = blendColor(config.color, "#ffffff", 0.15, 0.45);
        ctx.beginPath();
        ctx.arc(node.projected.x, node.projected.y, radius + 5, 0, Math.PI * 2);
        ctx.stroke();
      }
      state.regionProjection.push({
        region: node.region,
        x: node.projected.x,
        y: node.projected.y,
        z: node.projected.z,
        radius: Math.max(8, radius + 4),
      });
      projectedForLabels.push({
        region: node.region,
        projected: node.projected,
        markerIndex: 0,
      });
    }
    if (state.showContours) drawRegionLabels(projectedForLabels);
    dom.visibleCount.textContent = String(connectivity.nodes.length);
    dom.cellTypeCount.textContent = String(edges.length);
    dom.secondaryCountLabel.textContent = "visible links";
    dom.connectivityEdgeCount.textContent = `${edges.length} of ${connectivity.metadata.edgeCount} links`;
    dom.connectivityLegendThreshold.textContent = `Top ${100 - state.connectivityPercentile}%`;
    dom.connectivityLegendMinPercentile.textContent = `P${state.connectivityPercentile}`;
    dom.connectivityLegendMinValue.textContent = `≥ ${threshold.toFixed(3)}`;
    dom.connectivityLegendMaxValue.textContent = values[values.length - 1].toFixed(3);
  }

  function render(now) {
    if (now - lastFrame < 30) {
      requestAnimationFrame(render);
      return;
    }
    const delta = Math.min(40, now - lastFrame);
    lastFrame = now;
    if (state.autoRotate && !state.dragging) state.targetRotationY += delta * 0.00012;
    state.rotationX += (state.targetRotationX - state.rotationX) * 0.1;
    state.rotationY += (state.targetRotationY - state.rotationY) * 0.1;
    state.zoom += (state.targetZoom - state.zoom) * 0.12;

    ctx.clearRect(0, 0, width, height);
    if (state.showShell) drawAtlasAnatomy();
    if (state.dataLayer === "cells" || state.dataLayer === "genes") drawRegions();
    else drawConnectivity();
    requestAnimationFrame(render);
  }

  function resizeCanvas() {
    const rect = dom.viewer.getBoundingClientRect();
    pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    width = Math.max(1, rect.width);
    height = Math.max(1, rect.height);
    dom.canvas.width = Math.round(width * pixelRatio);
    dom.canvas.height = Math.round(height * pixelRatio);
    dom.canvas.style.width = `${width}px`;
    dom.canvas.style.height = `${height}px`;
    ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  }

  function formatPercent(value) {
    return `${(value * 100).toFixed(value < 0.1 ? 1 : 0)}%`;
  }

  function buildCellTypeControls() {
    dom.cellTypeList.replaceChildren();
    const allButton = document.createElement("button");
    allButton.type = "button";
    allButton.className = "cell-type-button";
    allButton.dataset.cellType = ALL_CELL_TYPES;
    allButton.innerHTML = `
      <span class="cell-type-dot multicolor"></span>
      <span>All cell types</span>
      <small>${state.cellTypes.length} classes</small>
    `;
    allButton.addEventListener("click", () => selectCellType(ALL_CELL_TYPES));
    dom.cellTypeList.append(allButton);

    state.cellTypes.forEach((cellType) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "cell-type-button";
      button.dataset.cellType = cellType;
      button.innerHTML = `
        <span class="cell-type-dot" style="color:${colors[cellType] || "#61ddb2"}"></span>
        <span>${cellType}</span>
        <small>${formatPercent(
          state.regions.reduce((sum, region) => sum + (region.composition[cellType] || 0), 0) /
            state.regions.length,
        )}</small>
      `;
      button.addEventListener("click", () => selectCellType(cellType));
      dom.cellTypeList.append(button);
    });
    dom.legendKey.replaceChildren();
    state.cellTypes.forEach((cellType) => {
      const item = document.createElement("span");
      item.innerHTML = `<i style="--key-color:${colors[cellType] || "#9fb4bb"}"></i>${cellType}`;
      dom.legendKey.append(item);
    });
    syncCellTypeControls();
  }

  function syncCellTypeControls() {
    const allMode = isAllCellTypes();
    const cellLayer = state.dataLayer === "cells";
    document.querySelectorAll(".cell-type-button").forEach((button) => {
      button.classList.toggle("active", button.dataset.cellType === state.selectedCellType);
    });
    dom.legendSingle.hidden = !cellLayer || allMode;
    dom.legendAll.hidden = !cellLayer || !allMode;
    dom.abundance.disabled = allMode;
    dom.abundanceSection.classList.toggle("disabled", allMode);
    dom.abundanceValue.textContent = allMode ? "All" : `${Math.round(state.minimum * 100)}%`;
    dom.legendTitle.textContent = allMode ? "All cell types" : state.selectedCellType;
    dom.focusLabel.textContent = allMode ? "Dominant cell class" : state.selectedCellType;
    const accent = colors[allMode ? dominantCellType(state.regions[0]).cellType : state.selectedCellType] || "#61ddb2";
    dom.focusSwatch.style.background = accent;
    dom.focusSwatch.style.color = accent;
    updateAnatomyMetrics();
  }

  function selectCellType(cellType) {
    state.selectedCellType = cellType;
    syncCellTypeControls();
    if (state.selectedRegion) updateDetail(state.selectedRegion);
  }

  function updateConnectivityRangeBackground() {
    const minimum = Number(dom.connectivityFilter.min);
    const maximum = Number(dom.connectivityFilter.max);
    const progress =
      ((state.connectivityPercentile - minimum) / (maximum - minimum)) * 100;
    dom.connectivityFilter.style.background = `linear-gradient(90deg, #3b4cc0 0%, #20c7c7 ${Math.max(12, progress * 0.42)}%, #f0e442 ${Math.max(22, progress * 0.72)}%, #d7191c ${progress}%, #243640 ${progress}%)`;
    const topPercent = 100 - state.connectivityPercentile;
    dom.connectivityValue.textContent = `Top ${topPercent}%`;
    dom.connectivityLegendThreshold.textContent = `Top ${topPercent}%`;
  }

  function syncDataLayerControls() {
    const cellLayer = state.dataLayer === "cells";
    const geneLayer = state.dataLayer === "genes";
    // Three modes, not two: the genes layer draws region markers like the cells
    // layer, so it keeps the marker legend and hides the connectivity chrome, but
    // it has no cell-class threshold or per-region composition of its own.
    const markerLayer = cellLayer || geneLayer;
    document.querySelectorAll("[data-layer]").forEach((button) => {
      button.classList.toggle("active", button.dataset.layer === state.dataLayer);
    });
    dom.abundanceSection.hidden = !cellLayer;
    dom.abundanceFilterSection.hidden = !cellLayer;
    dom.connectivitySection.hidden = markerLayer;
    dom.legendConnectivity.hidden = markerLayer;
    dom.visualKey.hidden = !markerLayer;
    dom.mappingKey.hidden = !markerLayer;
    dom.compositionSection.hidden = !cellLayer;
    dom.connectivityDetailSection.hidden =
      markerLayer || !state.selectedRegion || state.selectedRegion.isGroup;
    dom.connectionInsightSection.hidden =
      markerLayer || !state.selectedConnection;
    dom.interactionHintText.textContent = geneLayer
      ? "Drag to rotate anatomy · Scroll to zoom · Click a region for its cell-type detail"
      : cellLayer
        ? "Drag to rotate anatomy · Scroll to zoom · Click a cell-profile marker"
        : "Drag to rotate anatomy · Scroll to zoom · Click a connectivity node";
    if (geneLayer) {
      const range = getGeneRange();
      const covered = state.genes && state.genes.length ? getVisibleRegions().length : 0;
      dom.datasetStatus.classList.add("observed");
      dom.datasetStatus.innerHTML = `
        <span class="status-dot"></span>
        <span>Gene expression · global scope</span>
        <strong>${
          range.min === null
            ? "no data for this gene"
            : `${covered} regions with data`
        }</strong>
      `;
      dom.legendSingle.hidden = true;
      dom.legendAll.hidden = true;
    } else if (cellLayer) {
      const linked = state.dataStatus === "linked";
      dom.datasetStatus.classList.toggle(
        "observed",
        state.dataStatus === "observed" || linked,
      );
      dom.datasetStatus.innerHTML = `
        <span class="status-dot"></span>
        <span>${
          linked
            ? `Linked · ${state.linkedScopeLabel || "selection"}`
            : "Whole-brain cells + Allen 3D anatomy"
        }</span>
        <strong>${
          linked
            ? `${state.linkedActiveRegions ? state.linkedActiveRegions.size : 0} regions · scope-level`
            : state.dataStatus === "observed"
              ? `${state.importedRegionCount} imported regions`
              : "105 profiles placed"
        }</strong>
      `;
      syncCellTypeControls();
    } else {
      const config = connectivityConfig();
      dom.datasetStatus.classList.add("observed");
      dom.datasetStatus.innerHTML = `
        <span class="status-dot"></span>
        <span>${config.title} + Allen 3D anatomy</span>
        <strong>${connectivity.metadata.regionCount} regions</strong>
      `;
      dom.legendSingle.hidden = true;
      dom.legendAll.hidden = true;
      dom.connectivityLegendTitle.textContent = config.title;
      dom.viewer.style.setProperty("--connectivity-color", config.color);
      updateConnectivityRangeBackground();
    }
    updateFunctionFocusDisplay();
    // Tell the host page which layer is live: gene data is a cross-study merge with
    // the dataset axis collapsed, so the Explorer must disable its scope filters.
    window.dispatchEvent(
      new window.CustomEvent("digitalbrain-atlas-layer", {
        detail: { layer: state.dataLayer },
      }),
    );
  }

  function selectDataLayer(layer) {
    if (!["cells", "functional", "structural", "genes"].includes(layer)) return;
    const preserveConnection = state.selectedConnection?.layer === layer;
    state.dataLayer = layer;
    state.hoveredRegion = null;
    if (state.selectedConnection && state.selectedConnection.layer !== layer) {
      state.selectedConnection = null;
    }
    dom.tooltip.hidden = true;
    syncDataLayerControls();
    if (state.selectedRegion) {
      updateDetail(state.selectedRegion, { preserveConnection });
    }
  }

  function selectAnatomyStyle(style) {
    if (!["flecks", "boundaries"].includes(style)) return;
    state.anatomyStyle = style;
    document.querySelectorAll("[data-anatomy-style]").forEach((button) => {
      button.classList.toggle("active", button.dataset.anatomyStyle === style);
    });
  }

  function updateMemberRegionList(region) {
    const members = region?.isGroup
      ? state.regions
          .filter((candidate) => candidate.group === region.name)
          .sort((a, b) => a.acronym.localeCompare(b.acronym))
      : [];
    dom.memberRegionsSection.hidden = members.length === 0;
    dom.memberRegionsCount.textContent = members.length ? `${members.length} regions` : "—";
    dom.memberRegionList.replaceChildren();
    members.forEach((member) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "member-region-button";
      button.textContent = member.acronym;
      button.title = member.name;
      button.addEventListener("click", () => updateDetail(member));
      dom.memberRegionList.append(button);
    });
  }

  function getRegionConnections(region, layer = state.dataLayer) {
    const nodeIndex = connectivityIndexById.get(region.id) ?? -1;
    if (nodeIndex < 0 || !["functional", "structural"].includes(layer)) return [];
    const config = connectivityConfig(layer);
    return connectivity.edges
      .filter((edge) => edge[0] === nodeIndex || edge[1] === nodeIndex)
      .map((edge) => {
        const targetIndex = edge[0] === nodeIndex ? edge[1] : edge[0];
        const value = edge[config.metricIndex];
        return {
          sourceRegion: region,
          region: connectivityNodeRegions[targetIndex],
          sourceIndex: nodeIndex,
          targetIndex,
          value,
          percentile: valuePercentile(layer, value),
          key: edgeKey(nodeIndex, targetIndex),
        };
      })
      .sort((left, right) => right.value - left.value);
  }

  function strengthDescriptor(percentile) {
    if (percentile >= 99) return "exceptionally high";
    if (percentile >= 95) return "very high";
    if (percentile >= 90) return "high";
    if (percentile >= 75) return "above-average";
    if (percentile >= 40) return "mid-range";
    return "lower-range";
  }

  function sharedFunctionalContext(leftRegion, rightRegion) {
    const left = annotationFor(leftRegion)?.functions || [];
    const right = annotationFor(rightRegion)?.functions || [];
    const rightNormalized = new Set(right.map((item) => item.toLowerCase()));
    const shared = left.filter((item) => rightNormalized.has(item.toLowerCase()));
    if (shared.length) return shared.slice(0, 3).join(", ");
    const leftNetwork = annotationFor(leftRegion)?.networks?.[0];
    const rightNetwork = annotationFor(rightRegion)?.networks?.[0];
    if (leftNetwork && rightNetwork) return `${leftNetwork} ↔ ${rightNetwork}`;
    return "cross-system integration";
  }

  function connectionExplanation(connection) {
    const descriptor = strengthDescriptor(connection.percentile);
    const context = sharedFunctionalContext(
      connection.sourceRegion,
      connection.targetRegion,
    );
    if (connection.layer === "functional") {
      return `The project fMRI-derived FC weight is ${connection.value.toFixed(3)} (P${connection.percentile.toFixed(1)} across all ${connectivity.metadata.edgeCount.toLocaleString()} pairs), a ${descriptor} value in this matrix. This is compatible with coordinated fMRI signal variation between the two regions; a plausible functional context is ${context}. The weight is descriptive and does not prove direct communication, anatomical wiring or causality.`;
    }
    return `The project SC weight is ${connection.value.toFixed(3)} (P${connection.percentile.toFixed(1)} across all ${connectivity.metadata.edgeCount.toLocaleString()} pairs), a ${descriptor} value in this matrix. It is compatible with comparatively stronger structural coupling for this pair; a plausible systems context is ${context}. The undirected matrix does not establish direction, a monosynaptic tract or causality.`;
  }

  function updateRegionAnnotation(region) {
    const annotation = !region?.isGroup ? annotationFor(region) : null;
    dom.regionAnnotationSection.hidden = !annotation;
    dom.regionFunctionTags.replaceChildren();
    dom.regionNetworkTags.replaceChildren();
    if (!annotation) return;
    dom.regionOverview.textContent = annotation.overview;
    dom.regionRole.textContent = annotation.role;
    dom.regionNetworkBadge.textContent = annotation.dmn
      ? `DMN · ${annotation.dmn}`
      : "Curated context";
    annotation.functions.forEach((label) => {
      const tag = document.createElement("span");
      tag.textContent = label;
      dom.regionFunctionTags.append(tag);
    });
    annotation.networks.forEach((label) => {
      const tag = document.createElement("span");
      tag.textContent = label;
      dom.regionNetworkTags.append(tag);
    });
  }

  function updateConnectionInsight() {
    const connection = state.selectedConnection;
    const visible =
      connection &&
      connection.layer === state.dataLayer &&
      ["functional", "structural"].includes(state.dataLayer);
    dom.connectionInsightSection.hidden = !visible;
    if (!visible) return;
    const config = connectivityConfig(connection.layer);
    dom.connectionInsightLayer.textContent = config.shortLabel;
    dom.connectionPair.textContent = `${connection.sourceRegion.acronym} · ${connection.sourceRegion.name} ↔ ${connection.targetRegion.acronym} · ${connection.targetRegion.name}`;
    dom.connectionWeightLabel.textContent =
      connection.layer === "functional" ? "fMRI-derived FC weight" : "SC matrix weight";
    dom.connectionWeight.textContent = connection.value.toFixed(3);
    dom.connectionPercentile.textContent = `P${connection.percentile.toFixed(1)}`;
    dom.connectionExplanation.textContent = connectionExplanation(connection);
  }

  function selectConnection(sourceRegion, connection, layer = state.dataLayer) {
    state.selectedConnection = {
      layer,
      key: connection.key,
      sourceRegion,
      targetRegion: connection.region,
      sourceIndex: connection.sourceIndex,
      targetIndex: connection.targetIndex,
      value: connection.value,
      percentile: connection.percentile,
    };
    updateDetail(sourceRegion, { preserveConnection: true });
  }

  function updateConnectivityDetail(region) {
    const cellLayer = state.dataLayer === "cells";
    const connections =
      !cellLayer && !region.isGroup ? getRegionConnections(region) : [];
    dom.connectivityDetailSection.hidden = cellLayer || connections.length === 0;
    dom.connectivityDetailList.replaceChildren();
    if (!connections.length) return;
    const config = connectivityConfig();
    dom.connectivityDetailTitle.textContent = `Strongest ${config.shortLabel} connections`;
    dom.connectivityDetailUnit.textContent = "Weight · percentile";
    connections.slice(0, 6).forEach((connection) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "connectivity-detail-row";
      if (
        state.selectedConnection?.layer === state.dataLayer &&
        state.selectedConnection.key === connection.key
      ) {
        row.classList.add("selected");
      }
      const colour = spectrumColor(
        spectrumPosition(connection.percentile),
        1,
      );
      row.innerHTML = `
        <span class="connection-label"><i class="edge-colour" style="--edge-colour:${colour}"></i>${connection.region.acronym} · ${connection.region.name}</span>
        <span class="connection-metric"><strong>${connection.value.toFixed(3)}</strong><small>P${connection.percentile.toFixed(1)}</small></span>
      `;
      row.addEventListener("click", () => selectConnection(region, connection));
      dom.connectivityDetailList.append(row);
    });
  }

  // --- gene expression detail panel ---
  //
  // The atlas never computes gene numbers; it asks the host's provider and renders
  // whatever comes back. A class absent from `rows` has no cells at all in this
  // region, which is a different statement from "expression measured as zero", so
  // it is labelled rather than drawn as an empty bar at 0.

  function geneDetailFor(region) {
    if (!state.geneDetailProvider) return null;
    try {
      return state.geneDetailProvider(region.acronym) || null;
    } catch (error) {
      // A broken provider must not take the whole panel down with it.
      return null;
    }
  }

  function geneMetricLabel(metric) {
    return metric === "detection" ? "detection rate" : "mean expression";
  }

  function geneFocusLabel(gene) {
    if (!gene || !gene.symbol) return "Gene expression";
    return `${gene.symbol} · ${geneMetricLabel(gene.metric || state.geneMetric)}`;
  }

  function formatGeneValue(value, metric) {
    if (typeof value !== "number" || !Number.isFinite(value)) return "—";
    return (metric || state.geneMetric) === "detection"
      ? formatPercent(value)
      : value.toFixed(3);
  }

  function geneSwatchColour(gene) {
    const value = gene && gene.value;
    if (typeof value !== "number" || !Number.isFinite(value)) return "#4b5566";
    const { min, max } = getRange();
    const span = max - min;
    return spectrumColor(span > 0 ? (value - min) / span : 1, 1);
  }

  function geneSupportLabel(gene) {
    if (!gene) return "Gene expression";
    const support = gene.support;
    if (!support) return "No data in this region";
    const datasets = Number(support.datasets) || 0;
    const donors = Number(support.donors) || 0;
    const cells = Number(support.cells) || 0;
    return `${datasets.toLocaleString()} datasets · ${donors.toLocaleString()} donors · ${cells.toLocaleString()} cells`;
  }

  function geneRankBadge(region, gene) {
    if (!gene || typeof gene.value !== "number" || !Number.isFinite(gene.value)) {
      return "No data";
    }
    const ranked = state.regions
      .filter((candidate) => candidate.hasAnatomy)
      .map((candidate) => ({ acronym: candidate.acronym, value: geneValueFor(candidate) }))
      .filter((entry) => entry.value !== null)
      .sort((a, b) => b.value - a.value);
    const rank = ranked.findIndex((entry) => entry.acronym === region.acronym) + 1;
    return rank > 0 ? `#${rank} of ${ranked.length}` : `${ranked.length} with data`;
  }

  function geneNoticeRow(text) {
    const row = document.createElement("div");
    row.className = "composition-row composition-notice";
    const label = document.createElement("span");
    label.textContent = text;
    row.append(label);
    return row;
  }

  function renderGeneComposition(gene) {
    if (!gene) {
      dom.compositionBars.append(
        geneNoticeRow("Pick a gene to see its per-class values here."),
      );
      return;
    }
    if (gene.detailAvailable === false) {
      dom.compositionBars.append(
        geneNoticeRow(
          `${gene.symbol || "This gene"} ships region-level values only, so the per-class breakdown is not available.`,
        ),
      );
      return;
    }

    const metric = gene.metric || state.geneMetric;
    const byType = new Map();
    (gene.rows || []).forEach((entry) => {
      if (entry && entry.cellType) byType.set(entry.cellType, entry);
    });
    if (!byType.size) {
      dom.compositionBars.append(
        geneNoticeRow("No cells of any class were measured in this region."),
      );
      return;
    }

    const values = [...byType.values()]
      .map((entry) => entry[metric])
      .filter((value) => typeof value === "number" && Number.isFinite(value));
    const maxValue = metric === "detection" ? 1 : Math.max(...values, 0);

    // Ordered by value with the measured classes first, so the ones carrying data
    // are at the top and the absent ones collect at the bottom.
    state.cellTypes
      .map((cellType) => {
        const entry = byType.get(cellType);
        const raw = entry ? entry[metric] : undefined;
        const measured = typeof raw === "number" && Number.isFinite(raw);
        return { cellType, value: measured ? raw : null, cells: entry ? entry.cells : 0 };
      })
      .sort((a, b) => {
        if (a.value === null && b.value === null) return a.cellType.localeCompare(b.cellType);
        if (a.value === null) return 1;
        if (b.value === null) return -1;
        return b.value - a.value;
      })
      .forEach(({ cellType, value, cells }) => {
        const row = document.createElement("div");
        row.className = `composition-row${value === null ? " composition-missing" : ""}`;

        const label = document.createElement("span");
        label.textContent = cellType;
        row.append(label);

        const readout = document.createElement("strong");
        readout.textContent = value === null ? "No data" : formatGeneValue(value, metric);
        row.append(readout);

        const track = document.createElement("div");
        track.className = "bar-track";
        if (value !== null) {
          const fill = document.createElement("div");
          fill.className = "bar-fill";
          fill.style.width = `${maxValue > 0 ? (value / maxValue) * 100 : 0}%`;
          track.append(fill);
          // The cell count is the weight behind this class's mean.
          row.title = `${cellType}: ${formatGeneValue(value, metric)} from ${(Number(cells) || 0).toLocaleString()} cells`;
        } else {
          row.title = `${cellType}: no cells of this class were measured in this region`;
        }
        row.append(track);

        dom.compositionBars.append(row);
      });
  }

  function updateDetail(region, options = {}) {
    const preserveConnection = Boolean(options.preserveConnection);
    if (!region) {
      state.selectedRegion = null;
      state.selectedConnection = null;
      state.selectedGroup = null;
      dom.detailEmpty.hidden = false;
      dom.detailContent.hidden = true;
      dom.detailPanel.classList.remove("open");
      updateMemberRegionList(null);
      updateConnectivityDetail({ isGroup: true });
      updateRegionAnnotation(null);
      updateConnectionInsight();
      updateAnatomySelection();
      return;
    }

    if (!preserveConnection) state.selectedConnection = null;
    state.selectedRegion = region;
    state.selectedGroup = region.isGroup ? region.name : region.group;
    updateAnatomySelection();
    state.autoRotate = false;
    dom.rotateToggle.checked = false;
    dom.detailEmpty.hidden = true;
    dom.detailContent.hidden = false;
    dom.detailPanel.classList.add("open");
    dom.detailCode.textContent = region.acronym;
    dom.detailName.textContent = region.name;
    dom.detailGroup.textContent = region.group;
    updateMemberRegionList(region);
    updateConnectivityDetail(region);
    updateRegionAnnotation(region);
    updateConnectionInsight();
    const allMode = isAllCellTypes();
    const dominant = dominantCellType(region);
    const focusCellType = allMode ? dominant.cellType : state.selectedCellType;
    const value = region.composition[focusCellType] || 0;
    const cellLayer = state.dataLayer === "cells";
    const geneLayer = state.dataLayer === "genes";
    // Asked once per selection: the panel below reports value, support and the
    // per-class breakdown from the same snapshot.
    const gene = geneLayer ? geneDetailFor(region) : null;
    const connections = cellLayer || geneLayer ? [] : getRegionConnections(region);
    const connectionConfig = cellLayer || geneLayer ? null : connectivityConfig();
    dom.focusLabel.textContent = cellLayer
      ? allMode
        ? `Dominant · ${dominant.cellType}`
        : state.selectedCellType
      : geneLayer
        ? geneFocusLabel(gene)
        : connections.length
          ? `Strongest ${connectionConfig.shortLabel} weight`
          : connectionConfig.title;
    dom.focusValue.textContent = cellLayer
      ? formatPercent(value)
      : geneLayer
        ? formatGeneValue(gene && gene.value, gene && gene.metric)
        : connections.length
          ? connections[0].value.toFixed(3)
          : "—";
    const focusColor = cellLayer
      ? colors[focusCellType] || "#61ddb2"
      : geneLayer
        ? geneSwatchColour(gene)
        : connections.length
          ? spectrumColor(spectrumPosition(connections[0].percentile), 1)
          : connectionConfig.color;
    dom.focusSwatch.style.background = focusColor;
    dom.focusSwatch.style.color = focusColor;
    dom.detailDataStatus.textContent = cellLayer
      ? state.dataStatus === "linked"
        ? "Linked · scope-level composition"
        : state.dataStatus === "observed"
          ? "Imported composition"
          : "Illustrative"
      : geneLayer
        ? geneSupportLabel(gene)
        : `${connectionConfig.shortLabel} project matrix`;
    const geometryStatus = region.geometryMapping?.status;
    dom.detailGeometryStatus.textContent = region.isGroup
      ? "Aggregate; no single parcel"
      : geometryStatus === "recoverable_exact_or_union"
        ? `${region.geometryMapping.atlasAcronyms.join(" + ")} · exact Allen 3D`
        : geometryStatus === "curated_gyral_proxy"
          ? `${region.geometryMapping.atlasAcronyms.join(" + ")} · broad gyral proxy`
          : geometryStatus === "coarse_ontology_proxy"
            ? `${region.geometryMapping.atlasAcronyms.join(" + ")} · coarse anatomical proxy`
            : geometryStatus === "outside_atlas_volume"
              ? "Outside the Allen brain volume"
              : "No anatomical placement";
    dom.detailMappingBasis.textContent =
      region.geometryMapping?.basis || "No single anatomical crosswalk.";

    if (geneLayer) {
      dom.rankBadge.textContent = geneRankBadge(region, gene);
    } else if (!cellLayer) {
      dom.rankBadge.textContent = connections.length
        ? `${connectivity.metadata.regionCount}-region matrix`
        : "No connectivity";
    } else if (region.isGroup) {
      dom.rankBadge.textContent = `${region.memberCount} regions`;
    } else if (allMode) {
      dom.rankBadge.textContent = `${state.cellTypes.length} classes`;
    } else {
      const ranked = [...state.regions].sort(
        (a, b) =>
          (b.composition[state.selectedCellType] || 0) -
          (a.composition[state.selectedCellType] || 0),
      );
      const rank = ranked.findIndex((candidate) => candidate.id === region.id) + 1;
      dom.rankBadge.textContent = `#${rank} of ${ranked.length}`;
    }

    if (cellLayer && state.linkedActiveRegions && !region.isGroup) {
      const linkedCount = (state.linkedRegionCells || {})[region.acronym] || 0;
      dom.rankBadge.textContent = `${linkedCount.toLocaleString()} cells`;
    }

    dom.compositionBars.replaceChildren();
    if (geneLayer) {
      renderGeneComposition(gene);
      return;
    }
    const maxValue = Math.max(...state.cellTypes.map((cellType) => region.composition[cellType] || 0));
    state.cellTypes
      .map((cellType) => ({
        cellType,
        value: region.composition[cellType] || 0,
      }))
      .sort((a, b) => b.value - a.value)
      .forEach(({ cellType, value: cellValue }) => {
        const row = document.createElement("div");
        row.className = `composition-row${
          cellType === state.selectedCellType || (allMode && cellType === dominant.cellType)
            ? " active"
            : ""
        }`;
        row.innerHTML = `
          <span>${cellType}</span>
          <strong>${formatPercent(cellValue)}</strong>
          <div class="bar-track"><div class="bar-fill" style="width:${
            maxValue ? (cellValue / maxValue) * 100 : 0
          }%"></div></div>
        `;
        row.addEventListener("click", () => selectCellType(cellType));
        dom.compositionBars.append(row);
      });
  }

  function findRegionAt(x, y) {
    return [...state.regionProjection]
      .sort((a, b) => b.z - a.z)
      .find((point) => Math.hypot(point.x - x, point.y - y) <= point.radius)?.region;
  }

  function canvasCoordinates(event) {
    const rect = dom.canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function updateTooltip(region, point) {
    if (!region) {
      dom.tooltip.hidden = true;
      return;
    }
    if (state.dataLayer === "cells") {
      const focus = isAllCellTypes()
        ? dominantCellType(region)
        : {
            cellType: state.selectedCellType,
            value: region.composition[state.selectedCellType] || 0,
          };
      dom.tooltip.innerHTML = `
        <strong>${region.acronym}</strong>
        <span>${region.name}</span>
        <span>${isAllCellTypes() ? "Dominant · " : ""}${focus.cellType}: ${formatPercent(focus.value)}</span>
      `;
    } else {
      const config = connectivityConfig();
      const strongest = getRegionConnections(region)[0];
      dom.tooltip.innerHTML = `
        <strong>${region.acronym}</strong>
        <span>${region.name}</span>
        <span>${config.shortLabel} strongest: ${
          strongest ? `${strongest.region.acronym} · ${strongest.value.toFixed(3)}` : "not in matrix"
        }</span>
      `;
    }
    dom.tooltip.style.left = `${Math.min(width - 220, point.x)}px`;
    dom.tooltip.style.top = `${Math.max(50, Math.min(height - 50, point.y))}px`;
    dom.tooltip.hidden = false;
  }

  function setView(view) {
    const views = {
      lateral: { x: -0.05, y: -0.72 },
      dorsal: { x: -1.25, y: 0 },
      anterior: { x: 0, y: 0 },
    };
    const target = views[view] || views.lateral;
    state.targetRotationX = target.x;
    state.targetRotationY = target.y;
    document.querySelectorAll("[data-view]").forEach((button) => {
      button.classList.toggle("active", button.dataset.view === view);
    });
  }

  function updateRangeBackground() {
    const progress =
      ((Number(dom.abundance.value) - Number(dom.abundance.min)) /
        (Number(dom.abundance.max) - Number(dom.abundance.min))) *
      100;
    dom.abundance.style.background = `linear-gradient(90deg, var(--accent) 0%, var(--accent) ${progress}%, #243640 ${progress}%)`;
  }

  function resetFilters() {
    state.minimum = 0;
    dom.abundance.value = "0";
    dom.search.value = "";
    dom.searchResults.hidden = true;
    state.functionFocus = null;
    state.selectedConnection = null;
    updateFunctionFocusDisplay();
    updateRangeBackground();
    selectCellType(ALL_CELL_TYPES);
  }

  function updateFunctionFocusDisplay() {
    const topic = state.functionFocus;
    dom.functionFocus.hidden = !topic;
    if (!topic) return;
    const focusedConnections = functionFocusEdgeKeys().size;
    dom.functionFocusLabel.textContent = topic.label;
    dom.functionFocusSummary.textContent = `${topic.regions.length} regions · ${focusedConnections} strongest ${connectivityConfig().shortLabel} links highlighted`;
  }

  function setFunctionFocus(topicKey) {
    const topic = knowledge.topics[topicKey];
    if (!topic) return;
    state.functionFocus = { key: topicKey, ...topic };
    state.selectedConnection = null;
    if (state.dataLayer === "cells") selectDataLayer("functional");
    else {
      updateFunctionFocusDisplay();
      if (state.selectedRegion) updateDetail(state.selectedRegion);
    }
    dom.search.value = topic.label;
    dom.searchResults.hidden = true;
    showToast(`${topic.label}: highlighted ${topic.regions.length} annotated regions and ${functionFocusEdgeKeys().size} strongest within-set links.`);
  }

  function clearFunctionFocus() {
    state.functionFocus = null;
    state.selectedConnection = null;
    updateFunctionFocusDisplay();
    if (state.selectedRegion) updateDetail(state.selectedRegion);
  }

  function addSearchResult({ type, title, subtitle, meta, onSelect }) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "search-result";
    const topLine = document.createElement("span");
    topLine.className = "search-result-topline";
    const strong = document.createElement("strong");
    strong.textContent = title;
    const typeBadge = document.createElement("small");
    typeBadge.className = `result-type ${type}`;
    typeBadge.textContent = type;
    topLine.append(strong, typeBadge);
    const description = document.createElement("span");
    description.textContent = subtitle;
    const metadata = document.createElement("small");
    metadata.textContent = meta;
    button.append(topLine, description, metadata);
    button.addEventListener("click", onSelect);
    dom.searchResults.append(button);
  }

  function mappingLabelFor(region) {
    const status = region.geometryMapping?.status;
    if (status === "recoverable_exact_or_union") return "exact 3D anatomy";
    if (status === "curated_gyral_proxy") return "broad gyral proxy";
    if (status === "coarse_ontology_proxy") return "coarse anatomy proxy";
    return "outside atlas volume";
  }

  function searchConnectionResults(tokens, layer) {
    if (tokens.length < 2) return [];
    const config = connectivityConfig(layer);
    return connectivity.edges
      .map((edge) => {
        const left = connectivityNodeRegions[edge[0]];
        const right = connectivityNodeRegions[edge[1]];
        const haystack = `${left.acronym} ${left.name} ${right.acronym} ${right.name}`.toLowerCase();
        return {
          edge,
          left,
          right,
          value: edge[config.metricIndex],
          haystack,
        };
      })
      .filter((item) => tokens.every((token) => item.haystack.includes(token)))
      .sort((left, right) => right.value - left.value)
      .slice(0, 5);
  }

  function showSearchResults(query) {
    const normalized = query.trim().toLowerCase();
    if (!normalized) {
      dom.searchResults.hidden = true;
      return;
    }
    dom.searchResults.replaceChildren();
    let resultCount = 0;
    const topicResults = Object.entries(knowledge.topics)
      .filter(([, topic]) =>
        `${topic.label} ${topic.summary} ${topic.keywords.join(" ")}`
          .toLowerCase()
          .includes(normalized),
      )
      .slice(0, 3);
    topicResults.forEach(([key, topic]) => {
      addSearchResult({
        type: "function",
        title: topic.label,
        subtitle: topic.summary,
        meta: `${topic.regions.length} regions · highlights strongest within-set links`,
        onSelect: () => setFunctionFocus(key),
      });
      resultCount += 1;
    });

    const regionResults = state.regions
      .filter((region) => {
        const annotation = annotationFor(region);
        const searchable = [
          region.acronym,
          region.name,
          region.group,
          annotation?.overview,
          annotation?.role,
          ...(annotation?.functions || []),
          ...(annotation?.networks || []),
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return searchable.includes(normalized);
      })
      .slice(0, 6);
    regionResults.forEach((region) => {
      const annotation = annotationFor(region);
      addSearchResult({
        type: "region",
        title: region.acronym,
        subtitle: region.name,
        meta: annotation
          ? `${annotation.functions.slice(0, 2).join(" · ")} · ${mappingLabelFor(region)}`
          : mappingLabelFor(region),
        onSelect: () => {
          updateDetail(region);
          dom.search.value = region.acronym;
          dom.searchResults.hidden = true;
          if (region.hasAnatomy) state.targetZoom = Math.max(1.05, state.targetZoom);
          else showToast(`${region.acronym} lies outside the Allen brain volume.`);
        },
      });
      resultCount += 1;
    });

    const tokens = normalized.split(/\s+/).filter(Boolean);
    const layer = ["functional", "structural"].includes(state.dataLayer)
      ? state.dataLayer
      : "functional";
    searchConnectionResults(tokens, layer).forEach((item) => {
      const sourceIndex = item.edge[0];
      const targetIndex = item.edge[1];
      const percentile = valuePercentile(layer, item.value);
      addSearchResult({
        type: "connection",
        title: `${item.left.acronym} ↔ ${item.right.acronym}`,
        subtitle: `${item.left.name} ↔ ${item.right.name}`,
        meta: `${connectivityConfig(layer).shortLabel} ${item.value.toFixed(3)} · P${percentile.toFixed(1)}`,
        onSelect: () => {
          selectDataLayer(layer);
          selectConnection(
            item.left,
            {
              region: item.right,
              sourceIndex,
              targetIndex,
              value: item.value,
              percentile,
              key: edgeKey(sourceIndex, targetIndex),
            },
            layer,
          );
          dom.search.value = `${item.left.acronym} ↔ ${item.right.acronym}`;
          dom.searchResults.hidden = true;
        },
      });
      resultCount += 1;
    });
    dom.searchResults.hidden = resultCount === 0;
  }

  function parseCsvLine(line) {
    const values = [];
    let current = "";
    let quoted = false;
    for (let index = 0; index < line.length; index += 1) {
      const char = line[index];
      const next = line[index + 1];
      if (char === '"' && quoted && next === '"') {
        current += '"';
        index += 1;
      } else if (char === '"') {
        quoted = !quoted;
      } else if (char === "," && !quoted) {
        values.push(current.trim());
        current = "";
      } else {
        current += char;
      }
    }
    values.push(current.trim());
    return values;
  }

  function clearLinkedScope() {
    if (!state.linkedActiveRegions) return;
    for (const region of state.regions) {
      const base = baseCompositions.get(region.id);
      if (base) region.composition = { ...base };
    }
    state.linkedActiveRegions = null;
    state.linkedRegionCells = null;
    state.linkedScopeLabel = null;
    state.linkedCellStats = null;
    state.cellTypes = [...source.cellTypes];
    state.selectedCellType = ALL_CELL_TYPES;
    state.dataStatus = source.metadata.compositionProvenance;
    buildCellTypeControls();
    syncDataLayerControls();
    if (state.selectedRegion) {
      updateDetail(
        state.selectedRegion.isGroup
          ? aggregateGroup(state.selectedRegion.name)
          : state.selectedRegion,
      );
    }
  }

  // Apply a DigitalBrain Data Explorer scope: light up only the sampled
  // Brodmann regions (identity crosswalk on acronym), size them by real
  // per-region cell counts, and overlay the scope-level (marginal) 7-class
  // composition. Per-region composition is intentionally scope-level, not
  // region-resolved, because the source data only carries marginals.
  function applyLinkedScope(payload) {
    if (!payload) return;
    const known = new Set(state.regions.map((region) => region.acronym));
    const active = new Set(
      (payload.activeRegions || []).filter((acronym) => known.has(acronym)),
    );

    // Always revert to the illustrative baseline before overlaying a new scope.
    for (const region of state.regions) {
      const base = baseCompositions.get(region.id);
      if (base) region.composition = { ...base };
    }

    if (!active.size) {
      clearLinkedScope();
      showToast(
        `No atlas regions matched “${payload.scopeLabel || "the current selection"}”.`,
      );
      return;
    }

    // Adopt the Data Explorer's original cell-type vocabulary for this scope.
    const scopeCellTypes =
      Array.isArray(payload.cellTypes) && payload.cellTypes.length
        ? [...payload.cellTypes]
        : [...source.cellTypes];
    state.cellTypes = scopeCellTypes;
    state.selectedCellType = ALL_CELL_TYPES;

    const rawComposition = payload.composition || {};
    const total = scopeCellTypes.reduce(
      (sum, cellType) => sum + (Number(rawComposition[cellType]) || 0),
      0,
    );
    const normalized = Object.fromEntries(
      scopeCellTypes.map((cellType) => [
        cellType,
        total > 0 ? (Number(rawComposition[cellType]) || 0) / total : 0,
      ]),
    );
    for (const region of state.regions) {
      if (active.has(region.acronym)) {
        region.composition = { ...normalized };
      }
    }

    state.linkedActiveRegions = active;
    state.linkedRegionCells = payload.regionCells || {};
    state.linkedScopeLabel = payload.scopeLabel || null;
    state.linkedCellStats = payload.cellStats || null;
    state.dataStatus = "linked";
    state.dataLayer = "cells";

    buildCellTypeControls();
    syncDataLayerControls();
    if (state.selectedRegion && !state.selectedRegion.isGroup && !active.has(state.selectedRegion.acronym)) {
      updateDetail(null);
    } else if (state.selectedRegion) {
      updateDetail(
        state.selectedRegion.isGroup
          ? aggregateGroup(state.selectedRegion.name)
          : state.selectedRegion,
      );
    }
    showToast(
      `Linked to “${payload.scopeLabel || "selection"}”: ${active.size} sampled region${
        active.size === 1 ? "" : "s"
      } · scope-level composition.`,
    );
  }

  function importCompositionCsv(text) {
    const lines = text.split(/\r?\n/).filter((line) => line.trim());
    if (lines.length < 2) throw new Error("CSV contains no data rows.");
    const headers = parseCsvLine(lines[0]).map((header) => header.toLowerCase());
    const regionIndex = headers.indexOf("region");
    const cellTypeIndex = headers.indexOf("cell_type");
    const valueIndex = headers.indexOf("proportion");
    if ([regionIndex, cellTypeIndex, valueIndex].some((index) => index < 0)) {
      throw new Error("Expected columns: region, cell_type, proportion.");
    }

    const regionMap = new Map(
      state.regions.flatMap((region) => [
        [region.acronym.toLowerCase(), region],
        [region.id.toLowerCase(), region],
      ]),
    );
    const imported = new Map();
    const unknownRegions = new Set();
    const unknownCellTypes = new Set();
    let acceptedRows = 0;

    lines.slice(1).forEach((line) => {
      const fields = parseCsvLine(line);
      const regionLabel = fields[regionIndex]?.trim();
      const cellType = fields[cellTypeIndex]?.trim();
      let value = Number(fields[valueIndex]);
      const region = regionMap.get(regionLabel?.toLowerCase());
      if (!region) {
        if (regionLabel) unknownRegions.add(regionLabel);
        return;
      }
      if (!state.cellTypes.includes(cellType)) {
        if (cellType) unknownCellTypes.add(cellType);
        return;
      }
      if (!Number.isFinite(value) || value < 0) return;
      if (value > 1) value /= 100;
      if (!imported.has(region.id)) imported.set(region.id, {});
      imported.get(region.id)[cellType] = value;
      acceptedRows += 1;
    });

    if (!acceptedRows) throw new Error("No rows matched the displayed regions and cell classes.");

    for (const region of state.regions) {
      const values = imported.get(region.id);
      if (!values) continue;
      const merged = Object.fromEntries(
        state.cellTypes.map((cellType) => [cellType, values[cellType] ?? 0]),
      );
      const total = Object.values(merged).reduce((sum, value) => sum + value, 0);
      if (total > 0) {
        region.composition = Object.fromEntries(
          Object.entries(merged).map(([cellType, value]) => [cellType, value / total]),
        );
      }
    }

    state.dataStatus = "observed";
    state.importedRows = acceptedRows;
    state.importedRegionCount = imported.size;
    buildCellTypeControls();
    syncDataLayerControls();
    if (state.selectedRegion) {
      updateDetail(
        state.selectedRegion.isGroup
          ? aggregateGroup(state.selectedRegion.name)
          : state.selectedRegion,
      );
    }
    const caveats = [];
    if (unknownRegions.size) caveats.push(`${unknownRegions.size} unknown region labels`);
    if (unknownCellTypes.size) caveats.push(`${unknownCellTypes.size} unknown cell classes`);
    showToast(
      `Loaded ${acceptedRows} rows for ${imported.size} regions${
        caveats.length ? `; skipped ${caveats.join(" and ")}` : ""
      }.`,
    );
  }

  function showToast(message) {
    dom.toast.textContent = message;
    dom.toast.classList.add("show");
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => dom.toast.classList.remove("show"), 4200);
  }

  assignRegionPositions();
  buildCellTypeControls();
  syncDataLayerControls();
  selectAnatomyStyle("boundaries");
  resizeCanvas();
  updateRangeBackground();
  setAnatomyTransform();
  setVisualizationMode("three-d");
  requestAnimationFrame(render);

  new ResizeObserver(resizeCanvas).observe(dom.viewer);

  document.querySelectorAll("[data-mode]").forEach((button) => {
    button.addEventListener("click", () => setVisualizationMode(button.dataset.mode));
  });

  dom.anatomyStage.addEventListener("pointerdown", (event) => {
    state.anatomyDragging = true;
    state.anatomyDragMoved = false;
    state.anatomyPointerStart = { x: event.clientX, y: event.clientY };
    state.anatomyLastPointer = { x: event.clientX, y: event.clientY };
    dom.anatomyStage.setPointerCapture(event.pointerId);
    dom.anatomyStage.classList.add("dragging");
  });

  dom.anatomyStage.addEventListener("pointermove", (event) => {
    if (!state.anatomyDragging) return;
    const dx = event.clientX - state.anatomyLastPointer.x;
    const dy = event.clientY - state.anatomyLastPointer.y;
    if (
      Math.hypot(
        event.clientX - state.anatomyPointerStart.x,
        event.clientY - state.anatomyPointerStart.y,
      ) > 4
    ) {
      state.anatomyDragMoved = true;
      dom.tooltip.hidden = true;
    }
    state.anatomyTiltY = Math.max(-18, Math.min(18, state.anatomyTiltY + dx * 0.12));
    state.anatomyTiltX = Math.max(-12, Math.min(12, state.anatomyTiltX - dy * 0.10));
    state.anatomyLastPointer = { x: event.clientX, y: event.clientY };
    setAnatomyTransform();
  });

  dom.anatomyStage.addEventListener("pointerup", (event) => {
    state.anatomyDragging = false;
    dom.anatomyStage.classList.remove("dragging");
    dom.anatomyStage.releasePointerCapture(event.pointerId);
    window.setTimeout(() => {
      state.anatomyDragMoved = false;
    }, 0);
  });

  dom.anatomyStage.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      state.anatomyScale = Math.max(
        0.78,
        Math.min(1.12, state.anatomyScale * (event.deltaY > 0 ? 0.94 : 1.06)),
      );
      setAnatomyTransform();
    },
    { passive: false },
  );

  dom.anatomyReset.addEventListener("click", (event) => {
    event.stopPropagation();
    resetAnatomyTransform();
  });

  document.querySelectorAll(".anatomy-region").forEach((element) => {
    const group = element.dataset.group;
    element.addEventListener("pointermove", (event) => {
      if (!state.anatomyDragging) showAnatomyTooltip(group, event);
    });
    element.addEventListener("pointerleave", () => {
      dom.tooltip.hidden = true;
    });
    element.addEventListener("click", () => {
      if (!state.anatomyDragMoved) selectAnatomyGroup(group);
    });
    element.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        selectAnatomyGroup(group);
      }
    });
  });

  dom.canvas.addEventListener("pointerdown", (event) => {
    const point = canvasCoordinates(event);
    state.dragging = true;
    state.dragMoved = false;
    state.pointerStart = point;
    state.lastPointer = point;
    dom.canvas.setPointerCapture(event.pointerId);
    dom.canvas.classList.add("dragging");
  });

  dom.canvas.addEventListener("pointermove", (event) => {
    const point = canvasCoordinates(event);
    if (state.dragging) {
      const dx = point.x - state.lastPointer.x;
      const dy = point.y - state.lastPointer.y;
      if (Math.hypot(point.x - state.pointerStart.x, point.y - state.pointerStart.y) > 4) {
        state.dragMoved = true;
      }
      state.targetRotationY += dx * 0.007;
      state.targetRotationX = Math.max(
        -1.45,
        Math.min(1.45, state.targetRotationX + dy * 0.006),
      );
      state.lastPointer = point;
      state.hoveredRegion = null;
      updateTooltip(null);
    } else {
      const region = findRegionAt(point.x, point.y);
      state.hoveredRegion = region || null;
      updateTooltip(region, point);
    }
  });

  dom.canvas.addEventListener("pointerup", (event) => {
    const point = canvasCoordinates(event);
    if (!state.dragMoved) {
      const region = findRegionAt(point.x, point.y);
      if (region) updateDetail(region);
    }
    state.dragging = false;
    dom.canvas.classList.remove("dragging");
    dom.canvas.releasePointerCapture(event.pointerId);
  });

  dom.canvas.addEventListener("pointerleave", () => {
    if (!state.dragging) {
      state.hoveredRegion = null;
      updateTooltip(null);
    }
  });

  dom.canvas.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      state.targetZoom = Math.max(
        0.62,
        Math.min(1.85, state.targetZoom * (event.deltaY > 0 ? 0.92 : 1.08)),
      );
    },
    { passive: false },
  );

  dom.abundance.addEventListener("input", () => {
    const percent = Number(dom.abundance.value);
    state.minimum = percent / 100;
    dom.abundanceValue.textContent = `${percent}%`;
    updateRangeBackground();
  });

  dom.search.addEventListener("input", () => showSearchResults(dom.search.value));
  dom.search.addEventListener("keydown", (event) => {
    if (event.key === "Escape") dom.searchResults.hidden = true;
  });
  dom.clearFunctionFocus.addEventListener("click", clearFunctionFocus);
  dom.dmnToggle.addEventListener("change", () => {
    state.showDmnLabels = dom.dmnToggle.checked;
  });
  dom.shellToggle.addEventListener("change", () => {
    state.showShell = dom.shellToggle.checked;
  });
  dom.rotateToggle.addEventListener("change", () => {
    state.autoRotate = dom.rotateToggle.checked;
  });
  document.querySelectorAll("[data-layer]").forEach((button) => {
    button.addEventListener("click", () => selectDataLayer(button.dataset.layer));
  });
  document.querySelectorAll("[data-anatomy-style]").forEach((button) => {
    button.addEventListener("click", () =>
      selectAnatomyStyle(button.dataset.anatomyStyle),
    );
  });
  dom.connectivityFilter.addEventListener("input", () => {
    state.connectivityPercentile = Number(dom.connectivityFilter.value);
    updateConnectivityRangeBackground();
    if (state.selectedRegion) updateConnectivityDetail(state.selectedRegion);
  });

  document.getElementById("resetFilters").addEventListener("click", resetFilters);
  document.getElementById("zoomIn").addEventListener("click", () => {
    state.targetZoom = Math.min(1.85, state.targetZoom * 1.15);
  });
  document.getElementById("zoomOut").addEventListener("click", () => {
    state.targetZoom = Math.max(0.62, state.targetZoom / 1.15);
  });
  document.getElementById("zoomReset").addEventListener("click", () => {
    state.targetZoom = 1;
    setView("lateral");
  });
  document.querySelectorAll("[data-view]").forEach((button) => {
    button.addEventListener("click", () => setView(button.dataset.view));
  });
  document.getElementById("closeDetail").addEventListener("click", () => {
    state.selectedRegion = null;
    updateDetail(null);
  });
  document.getElementById("aboutButton").addEventListener("click", () => {
    dom.aboutDialog.showModal();
  });

  dom.csvInput.addEventListener("change", async () => {
    const [file] = dom.csvInput.files;
    if (!file) return;
    try {
      importCompositionCsv(await file.text());
    } catch (error) {
      showToast(`Import failed: ${error.message}`);
    } finally {
      dom.csvInput.value = "";
    }
  });

  // Direct same-page API for the DigitalBrain Data Explorer host.
  window.DigitalBrainAtlas = {
    applyScope(payload) {
      try {
        applyLinkedScope(payload);
      } catch (error) {
        showToast(`Link failed: ${error.message}`);
      }
    },
    clear() {
      clearLinkedScope();
    },

    // Gene expression layer. The host hands over an ordered array of genes, the
    // aggregation rule and metric they were computed under, and the density
    // calibration to read them against:
    //
    //   { metric, rule, scale: { breakpoint, reference, lowKnots },
    //     genes: [{ symbol, colour, values: { acronym: n }, support: { acronym: cells } }] }
    //
    // The order is load-bearing: it fixes each gene's offset angle. The colour comes
    // from the host because the chips and the cloud can only have one source of truth.
    // An acronym absent from a gene's values means "no data" and stays out of both the
    // colour range and the canvas.
    applyGeneValues(payload) {
      const scale = payload && payload.scale;
      // gene_atlas_web/ is gitignored, so index.json is a deployment artefact and a
      // stale payload against new code is a real scenario. Refuse it loudly: defaulting
      // to some range would render every density quietly wrong with nothing on screen
      // to say so.
      if (
        !scale
        || typeof scale.breakpoint !== "number"
        || typeof scale.reference !== "number"
        || !Array.isArray(scale.lowKnots)
        || scale.lowKnots.length !== 13
      ) {
        throw new Error(
          `applyGeneValues needs a densityScale for ${(payload && payload.rule) || "?"}/`
          + `${(payload && payload.metric) || "?"}`,
        );
      }
      if (payload.metric) {
        state.geneMetric = payload.metric === "detection" ? "detection" : "mean";
      }
      if (payload.rule) {
        state.geneRule = payload.rule === "donor_balanced" ? "donor_balanced" : "cell_weighted";
      }
      state.geneScale = scale;
      state.genes = (payload.genes || []).map((gene) => {
        const values = gene.values || {};
        const support = gene.support || {};
        return {
          symbol: gene.symbol,
          colour: gene.colour,
          values,
          support,
          byLabel: GenePointCloud.aggregateByLabel(
            { values, support }, labelToRegions, anatomy.labels.length,
          ),
        };
      });
      selectDataLayer("genes");
      return this.geneSummary();
    },

    clearGeneValues() {
      state.genes = null;
      state.geneScale = null;
      selectDataLayer("cells");
      return this.geneSummary();
    },

    // The atlas has no access to the gene payloads, so the host injects a lookup:
    // provider(acronym) -> { symbol, metric, value, support, detailAvailable, rows }
    // with rows = [{ cellType, mean, detection, cells }]. An absent class means no
    // data, never zero.
    setGeneDetailProvider(provider) {
      state.geneDetailProvider = typeof provider === "function" ? provider : null;
      if (state.selectedRegion && state.dataLayer === "genes") {
        updateDetail(state.selectedRegion, { preserveConnection: true });
      }
    },

    // Opens the detail panel for an acronym, the same path a canvas click takes.
    selectRegion(acronym) {
      const region = state.regions.find((candidate) => candidate.acronym === acronym);
      if (!region) return false;
      updateDetail(region);
      return true;
    },

    // Read-only view used by the gene search row for its legend and "n regions
    // with data" counter, and by the tests.
    geneSummary() {
      const range = getGeneRange();
      return {
        layer: state.dataLayer,
        metric: state.geneMetric,
        rule: state.geneRule,
        regions:
          state.dataLayer === "genes"
            ? getVisibleRegions().map((region) => region.acronym)
            : [],
        min: range.min,
        max: range.max,
        // One entry per gene, in the order the host gave them. min/max are measured on
        // the aggregated label values, which is what the cloud actually draws, so a
        // legend row describes the same numbers the viewer is looking at.
        genes: (state.genes || []).map((gene) => {
          let min = null;
          let max = null;
          gene.byLabel.hasValue.forEach((present, labelIndex) => {
            if (!present) return;
            const value = gene.byLabel.values[labelIndex];
            if (min === null || value < min) min = value;
            if (max === null || value > max) max = value;
          });
          return { symbol: gene.symbol, colour: gene.colour, min, max };
        }),
      };
    },

    // Whether an acronym exists in the catalogue and can be placed in 3D.
    knowsRegion(acronym) {
      return state.regions.some(
        (region) => region.acronym === acronym && region.hasAnatomy,
      );
    },
  };

  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.selectedRegion) {
      state.selectedRegion = null;
      updateDetail(null);
    }
  });
})();
