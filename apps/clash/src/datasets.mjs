const GEO_BASE = 'https://testingcf.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release/';
const LEGACY_GEO_BASE = 'https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/';

export const MODEL_URLS = {
  standard: 'https://github.com/vernesong/mihomo/releases/download/LightGBM-Model/Model.bin',
  middle: 'https://github.com/vernesong/mihomo/releases/download/LightGBM-Model/Model-middle.bin',
  large: 'https://github.com/vernesong/mihomo/releases/download/LightGBM-Model/Model-large.bin',
};

export const MODEL_LABELS = { standard: '标准模型', middle: '中等模型', large: '大型模型' };

export const DATASETS = [
  { key: 'geoip', name: 'GeoIP 数据库', filename: 'geoip.dat', url: `${GEO_BASE}geoip.dat`, description: 'GEOIP 规则数据' },
  { key: 'geosite', name: 'GeoSite 数据库', filename: 'geosite.dat', url: `${GEO_BASE}geosite.dat`, description: 'GEOSITE 域名分类数据' },
  { key: 'country', name: 'Country MMDB', filename: 'country.mmdb', url: `${GEO_BASE}country.mmdb`, description: '传统 GeoIP country 数据库' },
  { key: 'asn', name: 'ASN 数据库', filename: 'GeoLite2-ASN.mmdb', url: `${GEO_BASE}GeoLite2-ASN.mmdb`, description: 'ASN / IP 归属数据' },
  { key: 'model', name: 'Smart 模型', filename: 'Model.bin', url: MODEL_URLS.standard, description: 'Smart 版内核使用的 LightGBM 模型', model: true },
];

export const DATASET_KEYS = DATASETS.map(item => item.key);

export function datasetDefaults() {
  return Object.fromEntries(DATASETS.map(item => [item.key, item.url]));
}

/** Keep custom data URLs, but move untouched legacy defaults onto the jsDelivr mirror. */
export function normalizeDatasetUrls(urls) {
  const merged = { ...datasetDefaults(), ...(urls && typeof urls === 'object' ? urls : {}) };
  for (const item of DATASETS) {
    if (item.model) continue;
    const value = String(merged[item.key] || '');
    if (value.startsWith(LEGACY_GEO_BASE)) {
      merged[item.key] = `${GEO_BASE}${value.slice(LEGACY_GEO_BASE.length)}`;
    }
  }
  return merged;
}
