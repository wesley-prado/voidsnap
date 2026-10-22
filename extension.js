// VoidSnap para Cinnamon — versão 0.6
// Objetivo: ao soltar uma janela arrastada com SHIFT pressionado, encaixá-la
// (posição + tamanho) no monitor sob o ponteiro. Se outras janelas já ocupam parte
// dele, ela preenche todo o maior retângulo livre sob o ponteiro; com o monitor
// vazio, ocupa uma de 3 zonas iguais (colunas se horizontal, linhas se vertical).
// Durante o arrasto com SHIFT, um preview neon mostra o destino em tempo real.
// Aparência do preview e espaço mínimo: engrenagem em Extensões (settings-schema.json).
// Logs: Looking Glass (Alt+F2 -> "lg" -> aba Log) ou ~/.xsession-errors

const { Meta, Clutter, St, GLib } = imports.gi;
const Settings = imports.ui.settings;

const TAG = '[VoidSnap]';
const POSITION_LOG_INTERVAL_MS = 150;
// Zonas do monitor vazio: colunas em monitor horizontal, linhas em monitor vertical
const ZONE_COUNT = 3;

// Preview: o destino é recalculado por polling (não por position-changed) para reagir
// ao SHIFT mesmo com o mouse parado
const PREVIEW_POLL_MS = 30;
// Cor do fundo do preview; a opacidade vem das configurações
const PREVIEW_BACKGROUND_RGB = '4, 10, 24';
const PREVIEW_GLOW_ALPHA = 0.55;

// Valores ligados ao settings-schema.json. Os padrões abaixo só valem se as
// configurações não carregarem; o Cinnamon atualiza o objeto quando o usuário muda
// algo, e cada arrasto lê os valores atuais.
const _config = {
    neonColor: 'rgb(0,229,255)',
    backgroundOpacity: 35,
    animationMs: 160,
    minFreePx: 200,
};
let _settings = null;

let _metadata = null;

// Sinais permanentes (vivem entre enable() e disable()): [{ obj, id }]
let _signals = [];
// Sinais do arrasto atual (vivem entre grab-op-begin e grab-op-end): [{ obj, id }]
let _dragSignals = [];

let _dragWindow = null;
let _shiftWasActive = false;
let _lastPositionLog = 0;
let _modifierMethodLogged = false;
// Fonte GLib do snap adiado (precisa ser removida no disable())
let _snapIdleId = 0;

// Converte a cor do colorchooser ("rgb(r,g,b)", "rgba(r,g,b,a)" ou "#rrggbb") para
// "r, g, b", para compor com outro alfa. null se o formato não for reconhecido.
function _parseRgb(color) {
    let m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(color);
    if (m)
        return `${m[1]}, ${m[2]}, ${m[3]}`;
    m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color);
    if (m)
        return m.slice(1).map(h => parseInt(h, 16)).join(', ');
    return null;
}

function _getPreviewStyle() {
    const rgb = _parseRgb(_config.neonColor);
    const glow = rgb ? `rgba(${rgb}, ${PREVIEW_GLOW_ALPHA})` : _config.neonColor;
    return `background-color: rgba(${PREVIEW_BACKGROUND_RGB}, ${_config.backgroundOpacity / 100});` +
        `border: 2px solid ${_config.neonColor};` +
        'border-radius: 8px;' +
        `box-shadow: 0 0 18px 3px ${glow};`;
}

// Preview do arrasto atual: ator, timer de atualização e último estado aplicado
let _preview = null;
let _previewTimerId = 0;
let _previewPointer = null;
let _previewRect = null;

function _log(msg) {
    global.log(`${TAG} ${msg}`);
}

function _connect(list, obj, signal, callback) {
    const id = obj.connect(signal, callback);
    list.push({ obj, id });
    return id;
}

function _disconnectAll(list) {
    for (const { obj, id } of list) {
        try {
            obj.disconnect(id);
        } catch (e) {
            // O objeto pode já ter sido destruído (ex.: janela fechada durante o arrasto)
        }
    }
    list.length = 0;
}

// Lê a máscara de modificadores atual. Tenta a API do ClutterSeat e, se não estiver
// exposta pelo GI desta versão do Muffin, cai para global.get_pointer(), que lê o
// estado real do servidor X e funciona mesmo durante um grab.
function _getModifierState() {
    try {
        const seat = Clutter.get_default_backend().get_default_seat();
        const pointer = seat.get_pointer();
        if (pointer && typeof pointer.get_modifier_state === 'function') {
            if (!_modifierMethodLogged) {
                _log('modificadores via ClutterSeat.get_pointer().get_modifier_state()');
                _modifierMethodLogged = true;
            }
            return pointer.get_modifier_state();
        }
    } catch (e) {
        // fallback abaixo
    }

    if (!_modifierMethodLogged) {
        _log('modificadores via global.get_pointer()');
        _modifierMethodLogged = true;
    }
    const [, , mask] = global.get_pointer();
    return mask;
}

function _isShiftActive() {
    return (_getModifierState() & Clutter.ModifierType.SHIFT_MASK) !== 0;
}

function _isMoveOp(op) {
    return op === Meta.GrabOp.MOVING || op === Meta.GrabOp.KEYBOARD_MOVING;
}

// Muffin >= 5: (display, window, op). Versões antigas: (display, screen, window, op).
function _parseGrabArgs(args) {
    if (args.length >= 3 && args[1] instanceof Meta.Window)
        return { window: args[1], op: args[2] };
    return { window: args[2], op: args[3] };
}

function _onPositionChanged(window) {
    const shift = _isShiftActive();

    if (shift !== _shiftWasActive) {
        _shiftWasActive = shift;
        _log(`SHIFT ${shift ? 'pressionado' : 'solto'} durante arrasto de "${window.get_title()}"`);
    }

    if (!shift)
        return;

    const now = Date.now();
    if (now - _lastPositionLog < POSITION_LOG_INTERVAL_MS)
        return;
    _lastPositionLog = now;

    const rect = window.get_frame_rect();
    const [px, py] = global.get_pointer();
    _log(`arrasto+SHIFT "${window.get_title()}" janela=(${rect.x},${rect.y} ${rect.width}x${rect.height}) ponteiro=(${px},${py})`);
}

// Mantém o preview logo abaixo da janela arrastada: visível sobre as demais janelas
// sem cobrir a que está em movimento. Reaplicado a cada atualização porque o Muffin
// reordena o window_group quando o empilhamento das janelas muda.
function _restackPreview() {
    const actor = _dragWindow ? _dragWindow.get_compositor_private() : null;
    if (actor && actor.get_parent() === global.window_group)
        global.window_group.set_child_below_sibling(_preview, actor);
}

function _showPreview(zone) {
    const rect = { x: zone.x, y: zone.y, width: zone.width, height: zone.height };

    if (!_preview) {
        _preview = new St.Widget({ style: _getPreviewStyle(), reactive: false });
        global.window_group.add_child(_preview);
        _preview.set_position(rect.x, rect.y);
        _preview.set_size(rect.width, rect.height);
        _previewRect = rect;
        _restackPreview();
        return;
    }

    _restackPreview();
    if (_previewRect.x === rect.x && _previewRect.y === rect.y &&
        _previewRect.width === rect.width && _previewRect.height === rect.height)
        return;
    _previewRect = rect;

    // Transição implícita do Clutter: interpola da geometria atual (mesmo no meio de
    // uma animação anterior) até a nova
    _preview.save_easing_state();
    _preview.set_easing_mode(Clutter.AnimationMode.EASE_OUT_CUBIC);
    _preview.set_easing_duration(_config.animationMs);
    _preview.set_position(rect.x, rect.y);
    _preview.set_size(rect.width, rect.height);
    _preview.restore_easing_state();
}

function _hidePreview() {
    if (_preview) {
        _preview.destroy();
        _preview = null;
    }
    _previewPointer = null;
    _previewRect = null;
}

function _onPreviewTick() {
    if (!_dragWindow) {
        _previewTimerId = 0;
        return GLib.SOURCE_REMOVE;
    }

    if (!_isShiftActive()) {
        _hidePreview();
        return GLib.SOURCE_CONTINUE;
    }

    // Os obstáculos não mudam durante o arrasto: só recalcula se o ponteiro mexeu
    const [px, py] = global.get_pointer();
    if (_preview && _previewPointer && _previewPointer[0] === px && _previewPointer[1] === py)
        return GLib.SOURCE_CONTINUE;
    _previewPointer = [px, py];

    _showPreview(_getZoneRect(_dragWindow, px, py, false));
    return GLib.SOURCE_CONTINUE;
}

function _stopPreview() {
    if (_previewTimerId) {
        GLib.source_remove(_previewTimerId);
        _previewTimerId = 0;
    }
    _hidePreview();
}

function _endDrag() {
    _stopPreview();
    _disconnectAll(_dragSignals);
    _dragWindow = null;
    _shiftWasActive = false;
    _lastPositionLog = 0;
}

function _onGrabOpBegin(...args) {
    const { window, op } = _parseGrabArgs(args);
    if (!window || !_isMoveOp(op))
        return;

    // Garante que não sobram sinais de um arrasto anterior
    _endDrag();

    _dragWindow = window;
    _shiftWasActive = _isShiftActive();
    _log(`início do arrasto: "${window.get_title()}" (SHIFT=${_shiftWasActive})`);

    _connect(_dragSignals, window, 'position-changed', w => _onPositionChanged(w));
    _connect(_dragSignals, window, 'unmanaged', () => {
        _log('janela fechada durante o arrasto');
        _endDrag();
    });

    // No arrasto por teclado o ponteiro não indica o destino, então não há preview
    if (op === Meta.GrabOp.MOVING) {
        _previewTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PREVIEW_POLL_MS, _onPreviewTick);
        _onPreviewTick();
    }
}

// As zonas são calculadas dentro do maior retângulo vazio (sem nenhuma outra janela)
// que contém o ponteiro. Se ele for menor que _config.minFreePx em algum eixo, é
// inútil: as zonas voltam a usar a work area inteira.

// Obstáculos: janelas normais visíveis na workspace ativa, exceto a que está sendo
// encaixada, recortadas à work area do monitor. Maximizadas e em tela cheia são o
// "fundo" e não contam — senão nunca sobraria espaço livre em cima delas.
function _getObstacleRects(window, wa) {
    const waRight = wa.x + wa.width;
    const waBottom = wa.y + wa.height;
    const workspace = global.workspace_manager.get_active_workspace();
    return workspace.list_windows()
        .filter(w => w !== window &&
            w.get_window_type() === Meta.WindowType.NORMAL &&
            !w.minimized &&
            !w.is_fullscreen() &&
            w.get_maximized() !== Meta.MaximizeFlags.BOTH)
        .map(w => {
            const r = w.get_frame_rect();
            return {
                x1: Math.max(r.x, wa.x),
                y1: Math.max(r.y, wa.y),
                x2: Math.min(r.x + r.width, waRight),
                y2: Math.min(r.y + r.height, waBottom),
            };
        })
        .filter(r => r.x1 < r.x2 && r.y1 < r.y2);
}

// Maior retângulo (em área) da work area que contém o ponteiro e não cruza nenhum
// obstáculo; null se o ponteiro está sobre um obstáculo. As bordas de um retângulo
// vazio máximo sempre coincidem com bordas da work area ou de obstáculos, então basta
// testar cada par de bordas verticais ao redor do ponteiro e, para cada um, esticar
// o retângulo para cima e para baixo até o primeiro obstáculo naquela faixa.
function _getLargestEmptyRect(rects, wa, px, py) {
    const xs = new Set([wa.x, wa.x + wa.width]);
    for (const r of rects) {
        xs.add(r.x1);
        xs.add(r.x2);
    }
    const lefts = [...xs].filter(x => x <= px);
    const rights = [...xs].filter(x => x > px);

    let best = null;
    for (const x1 of lefts) {
        for (const x2 of rights) {
            let top = wa.y;
            let bottom = wa.y + wa.height;
            let blocked = false;
            for (const r of rects) {
                if (r.x2 <= x1 || r.x1 >= x2)
                    continue;
                if (r.y2 <= py)
                    top = Math.max(top, r.y2);
                else if (r.y1 > py)
                    bottom = Math.min(bottom, r.y1);
                else {
                    blocked = true;
                    break;
                }
            }
            if (blocked)
                continue;
            const area = (x2 - x1) * (bottom - top);
            if (!best || area > best.width * best.height)
                best = { x: x1, y: top, width: x2 - x1, height: bottom - top };
        }
    }
    return best;
}

// Área livre sob o ponteiro, ou null quando não há uma utilizável (o snap volta para
// as zonas da work area inteira). verbose = false no preview, que roda a cada movimento.
function _getFreeArea(window, wa, px, py, verbose) {
    const rects = _getObstacleRects(window, wa);
    const free = _getLargestEmptyRect(rects, wa, px, py);

    if (!free) {
        if (verbose)
            _log('ponteiro sobre outra janela; usando a work area inteira');
        return null;
    }
    if (free.width < _config.minFreePx || free.height < _config.minFreePx) {
        if (verbose)
            _log(`área livre (${free.x},${free.y} ${free.width}x${free.height}) pequena demais; usando a work area inteira`);
        return null;
    }
    return free;
}

// Divide [start, start + length) em ZONE_COUNT faixas e retorna a que contém pos.
// A última faixa absorve o resto da divisão para não sobrar linha de pixels.
function _getSlice(start, length, pos) {
    const size = Math.floor(length / ZONE_COUNT);
    const index = Math.min(ZONE_COUNT - 1, Math.max(0, Math.floor((pos - start) / size)));
    const sliceStart = start + index * size;
    const sliceLength = index === ZONE_COUNT - 1 ? start + length - sliceStart : size;
    return { index, start: sliceStart, length: sliceLength };
}

// Retângulo de destino no monitor onde o ponteiro está — não necessariamente o
// monitor original da janela. Se outras janelas reduzem o espaço livre, a janela
// preenche todo o retângulo livre: subdividi-lo deixaria faixas vazias na tela. Só
// quando o espaço livre é a work area inteira (ou não há um utilizável) ela é
// dividida em zonas: colunas se horizontal, linhas se vertical (altura > largura).
function _getZoneRect(window, px, py, verbose = true) {
    const pointerRect = new Meta.Rectangle({ x: px, y: py, width: 1, height: 1 });
    const monitor = global.display.get_monitor_index_for_rect(pointerRect);
    const geometry = global.display.get_monitor_geometry(monitor);
    const vertical = geometry.height > geometry.width;
    const wa = window.get_work_area_for_monitor(monitor);
    const free = _getFreeArea(window, wa, px, py, verbose);

    if (free && (free.width < wa.width || free.height < wa.height))
        return { monitor, vertical, fill: true, index: 0, wa, area: free, ...free };

    const area = { x: wa.x, y: wa.y, width: wa.width, height: wa.height };

    if (vertical) {
        const row = _getSlice(area.y, area.height, py);
        return { monitor, vertical, fill: false, index: row.index, wa, area,
            x: area.x, y: row.start, width: area.width, height: row.length };
    }
    const col = _getSlice(area.x, area.width, px);
    return { monitor, vertical, fill: false, index: col.index, wa, area,
        x: col.start, y: area.y, width: col.length, height: area.height };
}

// Remove maximização/tile nativo, como o reset_window do gTile. Precisa vir antes de
// qualquer checagem: janela maximizada reporta allows_resize() === false.
function _resetWindowState(window) {
    if (window.get_maximized() || window.tile_mode !== Meta.TileMode.NONE) {
        window.unmaximize(Meta.MaximizeFlags.HORIZONTAL);
        window.unmaximize(Meta.MaximizeFlags.VERTICAL);
        window.unmaximize(Meta.MaximizeFlags.BOTH);
    }
}

function _snapWindow(window, px, py) {
    const zone = _getZoneRect(window, px, py);

    _resetWindowState(window);

    if (!window.allows_resize()) {
        _log(`"${window.get_title()}" não permite redimensionamento; apenas movendo para a zona`);
        window.move_frame(true, zone.x, zone.y);
        return;
    }

    // Mesma ordem do gTile (move_resize_window): resize primeiro e move depois. Se o
    // Muffin limitar o tamanho, o move_frame final ainda garante a posição.
    window.move_resize_frame(true, zone.x, zone.y, zone.width, zone.height);
    window.move_frame(true, zone.x, zone.y);

    let r = window.get_frame_rect();

    // O Muffin respeita o tamanho mínimo declarado pelo cliente (WM_NORMAL_HINTS; ex.:
    // navegadores Chromium não ficam abaixo de 500px). Nesse caso a janela não cabe na
    // zona: mantém a borda da zona, mas recua só até o início da área livre — nunca
    // por cima das janelas fixadas nas laterais.
    if (r.width > zone.width || r.height > zone.height) {
        const x = Math.max(zone.area.x, Math.min(zone.x, zone.area.x + zone.area.width - r.width));
        const y = Math.max(zone.area.y, Math.min(zone.y, zone.area.y + zone.area.height - r.height));
        window.move_frame(true, x, y);
        r = window.get_frame_rect();
        _log(`"${window.get_title()}" tem tamanho mínimo maior que a zona; o Muffin limitou o resize`);
    }

    _log(`snap "${window.get_title()}" -> monitor ${zone.monitor}, ${zone.fill ? 'preenchendo área livre' : `${zone.vertical ? 'linha' : 'coluna'} ${zone.index + 1}/${ZONE_COUNT}`} área=(${zone.area.x},${zone.area.y} ${zone.area.width}x${zone.area.height}) alvo=(${zone.x},${zone.y} ${zone.width}x${zone.height}) obtido=(${r.x},${r.y} ${r.width}x${r.height})`);
}

function _cancelPendingSnap() {
    if (_snapIdleId) {
        GLib.source_remove(_snapIdleId);
        _snapIdleId = 0;
    }
}

function _onGrabOpEnd(...args) {
    const { window, op } = _parseGrabArgs(args);
    if (!_dragWindow || !_isMoveOp(op))
        return;

    const target = window || _dragWindow;
    const shift = _isShiftActive();
    const [px, py] = global.get_pointer();
    _log(`fim do arrasto: "${target.get_title()}" (SHIFT=${shift})`);
    _endDrag();

    // No arrasto por teclado o ponteiro não indica o destino
    if (!shift || op !== Meta.GrabOp.MOVING)
        return;

    // Adia para depois que o Muffin finaliza o grab; aplicado dentro do handler,
    // o fim do grab pode sobrescrever a geometria que definimos
    _cancelPendingSnap();
    _snapIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        _snapIdleId = 0;
        if (target.get_compositor_private())
            _snapWindow(target, px, py);
        return GLib.SOURCE_REMOVE;
    });
}

function init(metadata) {
    _metadata = metadata;
}

function _bindSettings() {
    try {
        _settings = new Settings.ExtensionSettings(_config, _metadata.uuid);
        _settings.bind('neon-color', 'neonColor');
        _settings.bind('background-opacity', 'backgroundOpacity');
        _settings.bind('animation-ms', 'animationMs');
        _settings.bind('min-free-px', 'minFreePx');
    } catch (e) {
        _settings = null;
        _log(`configurações indisponíveis, usando padrões: ${e}`);
    }
}

function enable() {
    _bindSettings();
    _connect(_signals, global.display, 'grab-op-begin', _onGrabOpBegin);
    _connect(_signals, global.display, 'grab-op-end', _onGrabOpEnd);
    _log(`habilitada (${_metadata ? _metadata.uuid : 'sem metadata'})`);
}

function disable() {
    _cancelPendingSnap();
    _endDrag();
    _disconnectAll(_signals);
    _modifierMethodLogged = false;
    if (_settings) {
        _settings.finalize();
        _settings = null;
    }
    _log('desabilitada');
}
