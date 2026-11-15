/**
 * Минимальный клиент REST API панели.
 *
 * Плагин не получает от хоста возможности «остановить/запустить сервер»:
 * в контексте есть только чтение БД и файловый туннель. Поэтому power-команды
 * идут в собственный REST API панели тем же API-ключом, который админ
 * создаёт вручную (Admin → Access Control → API Keys).
 */

const POWER_ACTIONS = new Set(['start', 'stop', 'restart', 'kill']);

/** Базовый URL панели, доступный из контейнера backend. */
export function resolvePanelBase(ctx) {
  const configured = String(ctx.getConfig('panelUrl') ?? '')
    .trim()
    .replace(/\/+$/, '');
  if (configured) return configured;
  const port = Number(process.env.PORT) || 3000;
  return `http://127.0.0.1:${port}`;
}

export function createPanelClient(ctx) {
  const base = resolvePanelBase(ctx);
  const key = String(ctx.getConfig('apiKey') ?? '').trim();
  const hasKey = key.length > 0;

  async function call(method, path, body, { timeoutMs = 20000 } = {}) {
    if (!hasKey) {
      throw new Error(
        'Не задан API-ключ панели (config.apiKey): без него нельзя управлять сервером — останавливать/запускать его и менять переменные карты',
      );
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers = { authorization: `Bearer ${key}` };
      // content-type только при наличии тела: Fastify отвергает пустое тело
      // с application/json (FST_ERR_CTP_EMPTY_JSON_BODY).
      if (body !== undefined) headers['content-type'] = 'application/json';
      const response = await fetch(`${base}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await response.text();
      let json = null;
      if (text) {
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
      }
      if (!response.ok || (json && json.success === false)) {
        const message =
          json?.error || json?.message || text || `HTTP ${response.status}`;
        // PATCH /variables отвечает 422 с полями: «WORLD_SEED: между 1 и …».
        const fields = json?.fields && typeof json.fields === 'object'
          ? Object.entries(json.fields)
              .map(([name, value]) => `${name}: ${value}`)
              .join('; ')
          : '';
        const detail = fields ? `${message} (${fields})` : message;
        throw new Error(`${method} ${path} → ${response.status}: ${String(detail).slice(0, 400)}`);
      }
      return json;
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new Error(`${method} ${path}: таймаут ${timeoutMs} мс`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    base,
    hasKey,
    /** Проверка, что ключ живой и панель отвечает. */
    ping() {
      return call('GET', '/api/servers', undefined, { timeoutMs: 10000 });
    },
    power(serverId, action) {
      if (!POWER_ACTIONS.has(action)) throw new Error(`Неизвестное действие: ${action}`);
      return call('POST', `/api/servers/${encodeURIComponent(serverId)}/${action}`);
    },
    command(serverId, command) {
      return call('POST', `/api/servers/${encodeURIComponent(serverId)}/console/command`, {
        command,
      });
    },
    /** Переменные шаблона сервера (нужно server.read у ключа). */
    getVariables(serverId) {
      return call('GET', `/api/servers/${encodeURIComponent(serverId)}/variables`, undefined, {
        timeoutMs: 10000,
      });
    },
    /** Запись переменных шаблона (нужно server.startup у ключа). */
    patchVariables(serverId, values) {
      return call(
        'PATCH',
        `/api/servers/${encodeURIComponent(serverId)}/variables`,
        values,
        { timeoutMs: 15000 },
      );
    },
  };
}
