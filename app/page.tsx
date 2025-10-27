'use client';

import { type ReactNode, useEffect, useMemo, useState } from 'react';
import materialsData from '../materials.json';
import hierarchyData from '../hierarchy.json';

type RawMaterialData = {
  printer_types: RawPrinter[];
};

type RawPrinter = {
  label: string;
  supported_machine_type_ids: string[];
  supported_product_names?: string[];
  materials: RawMaterial[];
};

type RawMaterial = {
  label: string;
  description: string;
  material_settings: RawMaterialSetting[];
};

type RawMaterialSetting = {
  label: string;
  scene_settings: SceneSettings;
};

type SceneSettings = {
  machine_type: string;
  material_code: string;
  layer_thickness_mm: number;
  [key: string]: unknown;
};

type CategoryNode = {
  id: string;
  label: string;
  codes: string[];
  ownCodes: string[];
  children: CategoryNode[];
};

type CategoryTree = CategoryNode[];

type PrinterOption = {
  id: string;
  label: string;
  machineTypeIds: string[];
  productNames: string[];
  materials: MaterialOption[];
};

type MaterialOption = {
  code: string;
  label: string;
  description: string;
  categoryPaths: string[];
  settings: LayerOption[];
};

type LayerOption = {
  id: string;
  label: string;
  layerThickness: number;
  scene: Pick<SceneSettings, 'machine_type' | 'material_code' | 'layer_thickness_mm'>;
};

type CategoryCodeMap = Record<string, string[]>;

type CodeToCategoryPaths = Record<string, string[]>;

const humanizeKey = (key: string) =>
  key
    .split(/[-_]/)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(' ');

const dedupe = <T,>(items: T[]) => Array.from(new Set(items));

const buildCategoryTree = (node: unknown, path: string[] = []): CategoryTree => {
  if (!node || typeof node !== 'object' || Array.isArray(node)) {
    return [];
  }

  return Object.entries(node as Record<string, unknown>).map(([key, value]) => {
    const currentPath = [...path, key];
    const id = currentPath.join('/');
    const label = humanizeKey(key);

    if (Array.isArray(value)) {
      const ownCodes = dedupe(value.filter((code): code is string => typeof code === 'string'));
      return {
        id,
        label,
        codes: ownCodes,
        ownCodes,
        children: []
      } satisfies CategoryNode;
    }

    const children = buildCategoryTree(value, currentPath);
    const codes = dedupe(children.flatMap((child) => child.codes));

    return {
      id,
      label,
      codes,
      ownCodes: [],
      children
    } satisfies CategoryNode;
  });
};

const flattenCategoryCodes = (nodes: CategoryTree): CategoryCodeMap => {
  const map: CategoryCodeMap = {};

  const visit = (node: CategoryNode) => {
    map[node.id] = node.codes;
    node.children.forEach(visit);
  };

  nodes.forEach(visit);
  return map;
};

const buildCodeToCategoryPaths = (nodes: CategoryTree): CodeToCategoryPaths => {
  const map: Record<string, Set<string>> = {};

  const visit = (node: CategoryNode, pathLabels: string[]) => {
    const nextPath = [...pathLabels, node.label];

    if (node.ownCodes.length) {
      const label = nextPath.join(' › ');
      node.ownCodes.forEach((code) => {
        if (!map[code]) {
          map[code] = new Set();
        }
        map[code].add(label);
      });
    }

    node.children.forEach((child) => visit(child, nextPath));
  };

  nodes.forEach((node) => visit(node, []));

  return Object.fromEntries(
    Object.entries(map).map(([code, labels]) => [code, Array.from(labels).sort((a, b) => a.localeCompare(b))])
  );
};

const buildPrinters = (data: RawMaterialData, codeToPaths: CodeToCategoryPaths): PrinterOption[] => {
  return data.printer_types
    .map((printer) => {
      const materials: MaterialOption[] = printer.materials
        .map((material) => {
          const thicknessMap = new Map<number, LayerOption>();

          material.material_settings.forEach((setting) => {
            const thickness = Number(setting.scene_settings.layer_thickness_mm);
            if (!thicknessMap.has(thickness)) {
              thicknessMap.set(thickness, {
                id: `${setting.scene_settings.material_code}-${thickness}`,
                label: setting.label,
                layerThickness: thickness,
                scene: {
                  machine_type: setting.scene_settings.machine_type,
                  material_code: setting.scene_settings.material_code,
                  layer_thickness_mm: setting.scene_settings.layer_thickness_mm
                }
              });
            }
          });

          const first = material.material_settings[0];
          const materialCode = first?.scene_settings.material_code ?? material.label;

          return {
            code: materialCode,
            label: material.label,
            description: material.description,
            categoryPaths: codeToPaths[materialCode] ?? [],
            settings: Array.from(thicknessMap.values()).sort((a, b) => a.layerThickness - b.layerThickness)
          } satisfies MaterialOption;
        })
        .filter((material) => material.settings.length > 0)
        .sort((a, b) => a.label.localeCompare(b.label));

      const printerId = printer.supported_machine_type_ids[0] ?? printer.label.toLowerCase().replace(/[^a-z0-9]+/g, '-');

      return {
        id: printerId,
        label: printer.label,
        machineTypeIds: printer.supported_machine_type_ids,
        productNames: printer.supported_product_names ?? [],
        materials
      } satisfies PrinterOption;
    })
    .filter((printer) => printer.materials.length > 0)
    .sort((a, b) => a.label.localeCompare(b.label));
};

const categoryTree = buildCategoryTree(hierarchyData);
const categoryCodeMap = flattenCategoryCodes(categoryTree);
const codeToCategoryPaths = buildCodeToCategoryPaths(categoryTree);
const printers = buildPrinters(materialsData as RawMaterialData, codeToCategoryPaths);

const DEFAULT_PRINTER_LABEL = 'Form 4';
const defaultPrinterId =
  printers.find((printer) => printer.label === DEFAULT_PRINTER_LABEL)?.id ?? printers[0]?.id ?? '';

const formatLayerLabel = (thickness: number) => `${thickness.toFixed(3)} mm`;

const copySceneSettings = async (scene: LayerOption['scene'], onSuccess: () => void, onError: () => void) => {
  const payload = JSON.stringify(
    {
      machine_type: scene.machine_type,
      material_code: scene.material_code,
      layer_thickness_mm: scene.layer_thickness_mm
    },
    null,
    2
  );

  try {
    await navigator.clipboard.writeText(payload);
    onSuccess();
  } catch (error) {
    console.error('Unable to copy JSON', error);
    onError();
  }
};

const DropdownLabel = ({ htmlFor, label }: { htmlFor: string; label: string }) => (
  <label htmlFor={htmlFor} style={{ fontSize: '0.85rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
    {label}
  </label>
);

const SectionCard = ({ children }: { children: ReactNode }) => (
  <section
    style={{
      border: '1px solid #111',
      borderRadius: 0,
      padding: '1.5rem',
      display: 'flex',
      flexDirection: 'column',
      gap: '1rem',
      background: '#fff'
    }}
  >
    {children}
  </section>
);

const Checkbox = ({
  checked,
  onChange,
  id
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  id: string;
}) => (
  <input
    id={id}
    type="checkbox"
    checked={checked}
    onChange={(event) => onChange(event.target.checked)}
    style={{ width: '1rem', height: '1rem', margin: 0 }}
  />
);

const CategoryFilter = ({
  tree,
  selected,
  toggle,
  counts
}: {
  tree: CategoryTree;
  selected: Set<string>;
  toggle: (id: string) => void;
  counts: Record<string, number>;
}) => {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        style={{
          border: '1px solid #111',
          borderRadius: 0,
          background: '#fff',
          padding: '0.75rem 1rem',
          textAlign: 'left',
          width: '100%',
          cursor: 'pointer'
        }}
      >
        Filter Materials
      </button>
      {open ? (
        <div
          style={{
            position: 'absolute',
            top: 'calc(100% + 0.5rem)',
            left: 0,
            border: '1px solid #111',
            background: '#fff',
            padding: '1rem',
            display: 'flex',
            flexDirection: 'column',
            gap: '0.75rem',
            minWidth: '260px',
            zIndex: 10,
            maxHeight: '18rem',
            overflowY: 'auto'
          }}
        >
          {tree.map((node) => (
            <CategoryBranch key={node.id} node={node} selected={selected} toggle={toggle} counts={counts} />
          ))}
        </div>
      ) : null}
    </div>
  );
};

const CategoryBranch = ({
  node,
  selected,
  toggle,
  counts
}: {
  node: CategoryNode;
  selected: Set<string>;
  toggle: (id: string) => void;
  counts: Record<string, number>;
}) => {
  const [expanded, setExpanded] = useState(false);
  const hasChildren = node.children.length > 0;
  const count = counts[node.id] ?? 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        <Checkbox id={`category-${node.id}`} checked={selected.has(node.id)} onChange={() => toggle(node.id)} />
        <label htmlFor={`category-${node.id}`} style={{ cursor: 'pointer', flexGrow: 1, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.75rem' }}>
          <span>{node.label}</span>
          <span style={{ fontSize: '0.75rem', color: '#555', minWidth: '2rem', textAlign: 'right' }}>({count})</span>
        </label>
        {hasChildren ? (
          <button
            type="button"
            onClick={() => setExpanded((prev) => !prev)}
            style={{
              border: '1px solid #111',
              borderRadius: 0,
              background: '#fff',
              fontSize: '0.75rem',
              padding: '0.15rem 0.5rem',
              cursor: 'pointer'
            }}
            aria-expanded={expanded}
            aria-label={`Toggle ${node.label}`}
          >
            {expanded ? 'Hide' : 'Show'}
          </button>
        ) : null}
      </div>
      {hasChildren && expanded ? (
        <div style={{ borderLeft: '1px solid #111', marginLeft: '1.1rem', paddingLeft: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          {node.children.map((child) => (
            <CategoryBranch key={child.id} node={child} selected={selected} toggle={toggle} counts={counts} />
          ))}
        </div>
      ) : null}
    </div>
  );
};

const Badge = ({ children }: { children: React.ReactNode }) => (
  <span
    style={{
      border: '1px solid #111',
      borderRadius: 0,
      padding: '0.15rem 0.4rem',
      fontSize: '0.7rem',
      letterSpacing: '0.02em'
    }}
  >
    {children}
  </span>
);

export default function Page() {
  const [selectedPrinterId, setSelectedPrinterId] = useState(defaultPrinterId);
  const [selectedCategoryIds, setSelectedCategoryIds] = useState<string[]>([]);
  const [selectedMaterialCode, setSelectedMaterialCode] = useState<string>('');
  const [selectedThickness, setSelectedThickness] = useState<string>('');
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle');

  const selectedPrinter = useMemo(() => printers.find((printer) => printer.id === selectedPrinterId), [selectedPrinterId]);

  const filteredMaterials = useMemo(() => {
    if (!selectedPrinter) {
      return [];
    }

    if (selectedCategoryIds.length === 0) {
      return selectedPrinter.materials;
    }

    const allowedCodes = new Set<string>();
    selectedCategoryIds.forEach((id) => {
      (categoryCodeMap[id] ?? []).forEach((code) => allowedCodes.add(code));
    });

    return selectedPrinter.materials.filter((material) => allowedCodes.has(material.code));
  }, [selectedPrinter, selectedCategoryIds]);

  useEffect(() => {
    if (!selectedPrinter) {
      setSelectedMaterialCode('');
      return;
    }

    const exists = filteredMaterials.some((material) => material.code === selectedMaterialCode);
    if (!exists) {
      setSelectedMaterialCode(filteredMaterials[0]?.code ?? '');
    }
  }, [filteredMaterials, selectedPrinter, selectedMaterialCode]);

  const selectedMaterial = useMemo(
    () => filteredMaterials.find((material) => material.code === selectedMaterialCode),
    [filteredMaterials, selectedMaterialCode]
  );

  const categoryCounts = useMemo(() => {
    if (!selectedPrinter) {
      return {} as Record<string, number>;
    }

    const printerCodes = new Set(selectedPrinter.materials.map((material) => material.code));

    return Object.fromEntries(
      Object.entries(categoryCodeMap).map(([id, codes]) => {
        let count = 0;
        codes.forEach((code) => {
          if (printerCodes.has(code)) {
            count += 1;
          }
        });
        return [id, count] as const;
      })
    );
  }, [selectedPrinter]);

  useEffect(() => {
    if (!selectedMaterial) {
      setSelectedThickness('');
      return;
    }

    const exists = selectedMaterial.settings.some((setting) => String(setting.layerThickness) === selectedThickness);
    if (!exists) {
      setSelectedThickness(selectedMaterial.settings[0] ? String(selectedMaterial.settings[0].layerThickness) : '');
    }
  }, [selectedMaterial, selectedThickness]);

  const thicknessOption = useMemo(() => {
    if (!selectedMaterial) {
      return undefined;
    }

    return selectedMaterial.settings.find((setting) => String(setting.layerThickness) === selectedThickness);
  }, [selectedMaterial, selectedThickness]);

  const handleCopy = async (scene: LayerOption['scene']) => {
    await copySceneSettings(
      scene,
      () => {
        setCopyState('copied');
        setTimeout(() => setCopyState('idle'), 1500);
      },
      () => {
        setCopyState('error');
        setTimeout(() => setCopyState('idle'), 1500);
      }
    );
  };

  const categorySelection = useMemo(() => new Set(selectedCategoryIds), [selectedCategoryIds]);

  const toggleCategory = (id: string) => {
    setSelectedCategoryIds((prev) => {
      if (prev.includes(id)) {
        return prev.filter((item) => item !== id);
      }
      return [...prev, id];
    });
  };

  return (
    <main style={{ maxWidth: '1100px', margin: '0 auto', padding: '3rem 1.5rem 4rem', display: 'flex', flexDirection: 'column', gap: '2.5rem' }}>
      <header style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        <h1 style={{ margin: 0, fontSize: '2.25rem', letterSpacing: '-0.02em' }}>Formlabs Material Compatibility</h1>
        <p style={{ maxWidth: '52ch', lineHeight: 1.5, margin: 0 }}>
          Choose your printer, narrow down materials by application, and copy ready-to-use material scene settings for your slice
          profiles.
        </p>
      </header>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '1.5rem' }}>
        <SectionCard>
          <DropdownLabel htmlFor="printer-select" label="Printer" />
          <select
            id="printer-select"
            value={selectedPrinterId}
            onChange={(event) => setSelectedPrinterId(event.target.value)}
            style={{
              border: '1px solid #111',
              borderRadius: 0,
              padding: '0.75rem 1rem',
              background: '#fff',
              cursor: 'pointer'
            }}
          >
            {printers.map((printer) => (
              <option key={printer.id} value={printer.id}>
                {printer.label}
              </option>
            ))}
          </select>
          {selectedPrinter?.productNames.length ? (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem' }}>
              {selectedPrinter.productNames.map((name) => (
                <Badge key={name}>{name}</Badge>
              ))}
            </div>
          ) : null}
        </SectionCard>

        <SectionCard>
          <DropdownLabel htmlFor="material-select" label="Material" />
          <select
            id="material-select"
            value={selectedMaterialCode}
            onChange={(event) => setSelectedMaterialCode(event.target.value)}
            style={{
              border: '1px solid #111',
              borderRadius: 0,
              padding: '0.75rem 1rem',
              background: '#fff',
              cursor: 'pointer'
            }}
            disabled={!filteredMaterials.length}
          >
            {filteredMaterials.map((material) => (
              <option key={material.code} value={material.code}>
                {material.label}
              </option>
            ))}
          </select>
          <CategoryFilter tree={categoryTree} selected={categorySelection} toggle={toggleCategory} counts={categoryCounts} />
          {selectedMaterial ? (
            <p style={{ margin: 0, fontSize: '0.9rem', lineHeight: 1.5 }}>{selectedMaterial.description}</p>
          ) : (
            <p style={{ margin: 0, fontSize: '0.9rem', lineHeight: 1.5, color: '#555' }}>
              No materials match the current filters.
            </p>
          )}
        </SectionCard>

        <SectionCard>
          <DropdownLabel htmlFor="layer-select" label="Layer Thickness" />
          <select
            id="layer-select"
            value={selectedThickness}
            onChange={(event) => setSelectedThickness(event.target.value)}
            style={{
              border: '1px solid #111',
              borderRadius: 0,
              padding: '0.75rem 1rem',
              background: '#fff',
              cursor: 'pointer'
            }}
            disabled={!selectedMaterial}
          >
            {selectedMaterial?.settings.map((setting) => (
              <option key={setting.id} value={String(setting.layerThickness)}>
                {formatLayerLabel(setting.layerThickness)}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => thicknessOption && handleCopy(thicknessOption.scene)}
            disabled={!thicknessOption}
            style={{
              border: '1px solid #111',
              borderRadius: 0,
              background: thicknessOption ? '#111' : '#f5f5f5',
              color: thicknessOption ? '#fff' : '#888',
              padding: '0.75rem 1rem',
              cursor: thicknessOption ? 'pointer' : 'not-allowed'
            }}
          >
            Copy Selected JSON
          </button>
          {copyState === 'copied' ? (
            <span style={{ fontSize: '0.85rem' }}>Copied!</span>
          ) : copyState === 'error' ? (
            <span style={{ fontSize: '0.85rem', color: '#b00020' }}>Copy failed</span>
          ) : null}
          {thicknessOption ? (
            <pre
              style={{
                background: '#f8f8f8',
                border: '1px solid #111',
                borderRadius: 0,
                padding: '1rem',
                margin: 0,
                fontSize: '0.85rem',
                overflowX: 'auto'
              }}
            >
              {JSON.stringify(thicknessOption.scene, null, 2)}
            </pre>
          ) : null}
        </SectionCard>
      </div>

      <section style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
        <h2 style={{ margin: 0, fontSize: '1.5rem' }}>Compatible Combinations</h2>
        {filteredMaterials.length === 0 ? (
          <p style={{ margin: 0, color: '#555' }}>No materials available with the current selection.</p>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '1.5rem' }}>
            {filteredMaterials.map((material) => (
              <article
                key={material.code}
                style={{
                  border: '1px solid #111',
                  borderRadius: 0,
                  padding: '1.5rem',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '0.9rem',
                  background: '#fff'
                }}
              >
                <header style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem', alignItems: 'baseline' }}>
                    <h3 style={{ margin: 0, fontSize: '1.1rem' }}>{material.label}</h3>
                    <Badge>{material.code}</Badge>
                  </div>
                  <p style={{ margin: 0, fontSize: '0.9rem', lineHeight: 1.5 }}>{material.description}</p>
                </header>
                {material.categoryPaths.length ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                    <strong style={{ fontSize: '0.75rem', letterSpacing: '0.05em' }}>Categories</strong>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                      {material.categoryPaths.map((path) => (
                        <span key={path} style={{ fontSize: '0.8rem' }}>
                          {path}
                        </span>
                      ))}
                    </div>
                  </div>
                ) : null}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                  <strong style={{ fontSize: '0.75rem', letterSpacing: '0.05em' }}>Layer Thickness</strong>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
                    {material.settings.map((setting) => (
                      <button
                        key={setting.id}
                        type="button"
                        onClick={() => handleCopy(setting.scene)}
                        style={{
                          border: '1px solid #111',
                          borderRadius: 0,
                          background: '#fff',
                          padding: '0.5rem 0.75rem',
                          cursor: 'pointer',
                          fontSize: '0.85rem'
                        }}
                      >
                        {formatLayerLabel(setting.layerThickness)}
                      </button>
                    ))}
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
