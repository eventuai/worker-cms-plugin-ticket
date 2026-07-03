import { Liquid } from 'liquidjs';

const templateCache = new Map<string, Promise<string>>();

interface JsonTemplate {
  sections?: Record<string, JsonSection>;
  order?: string[];
}

interface JsonSection {
  type: string;
  settings?: Record<string, unknown>;
}

function getEngine(views: Fetcher, globals: Record<string, unknown>): Liquid {
  return new Liquid({
    cache: true,
    extname: '.liquid',
    globals,
    root: ['layout', 'templates', 'sections', 'snippets'],
    relativeReference: false,
    fs: {
      readFileSync(file: string): string {
        throw new Error(`Synchronous asset reads are not supported: ${file}`);
      },
      readFile(file: string): Promise<string> {
        return loadTemplate(views, file);
      },
      existsSync(): boolean {
        return false;
      },
      async exists(file: string): Promise<boolean> {
        try {
          await loadTemplate(views, file);
          return true;
        } catch {
          return false;
        }
      },
      contains(): Promise<boolean> {
        return Promise.resolve(true);
      },
      containsSync(): boolean {
        return true;
      },
      resolve(root: string, file: string, ext: string): string {
        const fileKey = file.endsWith(ext) ? file : `${file}${ext}`;
        const folder = root.split('/').pop();
        if ((folder === 'sections' || folder === 'snippets') && !fileKey.startsWith(`${folder}/`)) {
          return `${folder}/${fileKey}`;
        }
        return fileKey;
      },
    },
  });
}

async function loadTemplate(views: Fetcher, path: string): Promise<string> {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const cached = templateCache.get(normalizedPath);
  if (cached) return cached;

  const template = views.fetch(`https://views.local${normalizedPath}`).then(async (response) => {
    if (!response.ok) {
      templateCache.delete(normalizedPath);
      throw new Error(`View file not found: ${normalizedPath}`);
    }
    return response.text();
  });

  templateCache.set(normalizedPath, template);
  return template;
}

export async function renderLiquid(
  views: Fetcher,
  templatePath: string,
  data: Record<string, unknown>,
): Promise<string> {
  const template = await loadTemplate(views, templatePath);
  const engine = getEngine(views, data);
  return String(await engine.parseAndRender(template, data));
}

/** Renders the JSON section templates used by the CMS's view system. */
export async function renderView(
  views: Fetcher,
  templatePath: string,
  data: Record<string, unknown>,
): Promise<string> {
  if (templatePath.endsWith('.liquid')) return renderLiquid(views, templatePath, data);

  const rawTemplate = await loadTemplate(views, templatePath.endsWith('.json') ? templatePath : `${templatePath}.json`);
  const template = JSON.parse(rawTemplate) as JsonTemplate;
  if (!template.order?.length) return '';

  const sections: string[] = [];
  for (const key of template.order) {
    const section = template.sections?.[key];
    if (!section) continue;
    sections.push(await renderLiquid(views, `/sections/${section.type}.liquid`, { ...data, section }));
  }

  return sections.join('\n');
}
