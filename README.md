# VoidSnap

Gerenciador de janelas híbrido e dinâmico para o Cinnamon (Linux Mint). Arraste
uma janela segurando **SHIFT**: o VoidSnap encontra o espaço vazio (*void*) da
tela e expande a janela até preenchê-lo, encostada nas vizinhas e sem cobrir
nenhuma.

## Como funciona

- **Maior retângulo vazio:** as outras janelas do monitor são tratadas como
  obstáculos. O VoidSnap calcula o maior retângulo livre que contém o ponteiro
  do mouse, e a janela ocupa esse retângulo inteiro. Com uma janela fixada no
  topo, a nova começa no pixel onde ela termina e vai até a base. Com uma
  janela à esquerda, a nova ocupa todo o espaço à direita.
- **Monitores horizontais e verticais:** o cálculo funciona nos dois eixos e em
  qualquer monitor. Num monitor vazio, a janela ocupa uma de 3 zonas iguais:
  colunas em monitores horizontais e linhas em monitores verticais.
- **Preview neon:** enquanto você arrasta com SHIFT, um retângulo de vidro fumê
  com borda e brilho neon mostra o destino em tempo real e desliza suavemente
  quando o destino muda. A cor, a opacidade e a velocidade são configuráveis.

## Instalação

Requer Cinnamon 6.0 a 6.6.

```sh
git clone https://github.com/wesley-prado/voidsnap ~/.local/share/cinnamon/extensions/voidsnap@wesleyprado.com
```

O nome da pasta precisa ser igual ao `uuid` do `metadata.json`
(`voidsnap@wesleyprado.com`). Se não for, o Cinnamon não carrega a extensão.

Depois ative **VoidSnap** em *Configurações do Sistema → Extensões*.

## Uso

1. Comece a arrastar uma janela pela barra de título.
2. Pressione **SHIFT**. O preview aparece na hora, mesmo com o mouse parado.
3. Mova o ponteiro até a área desejada. O preview desliza até o novo destino.
4. Solte o botão do mouse com o SHIFT ainda pressionado. Se soltar o SHIFT
   antes, o preview some e a janela fica onde foi solta, sem encaixe.

Arrastos pelo teclado (Alt+F7) não fazem encaixe, porque o ponteiro não indica
um destino.

## Configurações

Clique na engrenagem ao lado da extensão em *Extensões*. As mudanças valem a
partir do próximo arrasto, sem reiniciar o Cinnamon.

| Opção | Padrão | Efeito |
|---|---|---|
| Cor do neon | `rgb(0,229,255)` | Cor da borda e do brilho do preview |
| Opacidade do fundo | 35% | Transparência do fundo escuro do preview |
| Duração da animação | 160 ms | Tempo da transição do preview (0 = sem animação) |
| Espaço livre mínimo | 200 px | Abaixo disso, em largura ou altura, o snap usa a tela inteira |

Os valores ficam salvos por usuário em
`~/.config/cinnamon/spices/voidsnap@wesleyprado.com/`.

---

## Lógica geométrica

### 1. Monitor e área útil

O monitor de destino é o que está sob o ponteiro no momento em que a janela é
solta. Não é necessariamente o monitor de onde a janela saiu. Todo o cálculo
acontece dentro da **área útil** (*work area*) desse monitor, que é o monitor
menos painéis e barras.

A orientação vem da geometria do monitor: se a altura for maior que a largura,
o monitor é vertical.

### 2. Obstáculos

Contam como obstáculos as janelas da área de trabalho atual que:

- são do tipo normal (`Meta.WindowType.NORMAL`): painéis, docks, menus e o
  fundo da área de trabalho ficam de fora;
- não estão minimizadas;
- não estão em tela cheia nem maximizadas nos dois eixos;
- não são a própria janela arrastada.

As janelas maximizadas e em tela cheia são tratadas como **fundo**. Se
contassem como obstáculo, uma janela maximizada atrás das outras ocuparia o
monitor inteiro e nunca sobraria espaço livre.

Cada janela usa o retângulo do quadro (`get_frame_rect()`), que já descarta as
sombras invisíveis das janelas com decoração própria, como Chrome, Vivaldi e
apps GTK. Esse retângulo é recortado aos limites da área útil. Janelas que não
invadem a área útil são descartadas. Por isso não se usa `get_monitor()`, que só
indica onde está a maior parte da janela: uma janela que invade só um pouco o
monitor de destino também precisa contar.

### 3. Maior retângulo vazio que contém o ponteiro

O objetivo é achar o retângulo de maior área que:

- fica dentro da área útil;
- contém o ponteiro `(px, py)`;
- não cruza nenhum obstáculo.

**Ideia central:** num retângulo vazio que não pode mais crescer, cada lado está
encostado numa borda da área útil ou numa borda de algum obstáculo. Se um lado
estivesse solto, daria para empurrá-lo e aumentar a área. Por isso só é preciso
testar as bordas que já existem.

**Algoritmo** (`_getLargestEmptyRect`):

1. Junte as coordenadas X candidatas: as bordas esquerda e direita da área útil
   e as bordas esquerda e direita (`x1`, `x2`) de cada obstáculo.
2. Separe essas coordenadas em candidatas à **esquerda** (`x ≤ px`) e à
   **direita** (`x > px`).
3. Para cada par `(x1, x2)`, considere a faixa vertical entre eles e estique o
   retângulo para cima e para baixo a partir do ponteiro:
   - o **topo** desce até a borda de baixo do obstáculo mais baixo que fica
     inteiro acima do ponteiro dentro dessa faixa;
   - a **base** sobe até a borda de cima do obstáculo mais alto que fica
     inteiro abaixo do ponteiro dentro dessa faixa;
   - se algum obstáculo dessa faixa cobre a altura do ponteiro, o par é
     descartado, porque nenhum retângulo com essa largura contém o ponteiro sem
     cruzar esse obstáculo.
4. Fique com o resultado de maior área.

```
  área útil
  ┌───────────────────────────────┐
  │███████████ A ███████│         │  A, B = obstáculos
  │█████████████████████│         │  ● = ponteiro
  │─────────────────────┘         │
  │        ┌─────────────────┐    │  Faixa x1..x2: o topo para na base de A,
  │        │       ●         │    │  a base para no topo de B. Testando todos
  │        │                 │    │  os pares (x1, x2), vence o de maior área.
  │        └─────────────────┘    │
  │              ┌────────────────│
  │              │███████ B ██████│
  └───────────────────────────────┘
```

**Custo:** com `n` obstáculos, há até `n + 1` candidatas de cada lado do
ponteiro, ou seja, O(n²) pares, e cada par percorre os `n` obstáculos: O(n³) no
total. Com o número de janelas de um monitor real (dezenas, no máximo), isso
leva microssegundos e pode rodar a cada atualização do preview.

### 4. Quando o espaço livre não serve

O cálculo dinâmico é abandonado, e as 3 zonas passam a ser calculadas sobre a
área útil inteira, quando:

- **o ponteiro está sobre outra janela:** nenhum retângulo vazio contém o
  ponteiro;
- **o retângulo é pequeno demais:** largura ou altura abaixo do *espaço livre
  mínimo* (200 px por padrão).

### 5. Do retângulo livre à geometria final

- **Retângulo livre menor que a área útil** (há obstáculos ao redor): a janela
  ocupa o retângulo inteiro. Dividi-lo deixaria faixas vazias na tela. Assim,
  com o WhatsApp fixado no topo de um monitor vertical, o navegador começa no
  pixel onde o WhatsApp termina e desce até a base.
- **Retângulo livre igual à área útil** (monitor vazio), ou nos casos da seção
  4: a área é dividida em 3 faixas e a janela fica com a que contém o ponteiro.
  Isso permite começar um arranjo do zero: a primeira janela pega uma zona e a
  próxima preenche o resto. A última faixa fica com o resto da divisão inteira,
  para não sobrar nenhuma linha de pixels.

### 6. Tamanho mínimo das aplicações

Algumas aplicações não aceitam ficar abaixo de um tamanho mínimo. Os
navegadores baseados em Chromium, por exemplo, não ficam com menos de cerca de
500 px de largura. O Muffin, o gerenciador de janelas do Cinnamon, respeita esse
mínimo e pode deixar a janela maior que a zona. Nesse caso a extensão
reposiciona a janela:

```
x = max(área.x, min(zona.x, área.x + área.largura − janela.largura))
```

A janela continua alinhada à borda da zona e só recua o necessário para caber
na área livre. Ela nunca recua para antes do início da área livre, então não
invade as janelas fixadas. Se a janela for maior que a própria área livre, ela
encosta no início da área e transborda para o lado oposto.

---

## Integração com o Cinnamon

### Estrutura

```
voidsnap@wesleyprado.com/
├── metadata.json          # uuid, nome e versões do Cinnamon suportadas
├── extension.js           # toda a lógica
└── settings-schema.json   # tela de configurações (engrenagem)
```

O Cinnamon chama `init(metadata)` uma vez e depois `enable()` e `disable()` ao
ativar e desativar a extensão. Tudo o que `enable()` cria (sinais,
configurações, timers, atores) é desfeito em `disable()`.

### Detecção do arrasto

A extensão se conecta a dois sinais de `global.display`:

- **`grab-op-begin`:** só os arrastos de movimento (`Meta.GrabOp.MOVING`)
  interessam. A extensão guarda a janela arrastada e liga o timer do preview.
- **`grab-op-end`:** lê o SHIFT e a posição do ponteiro e, se o SHIFT estiver
  pressionado, agenda o snap.

A assinatura desses sinais mudou entre versões do Muffin: antes era
`(display, screen, window, op)`, hoje é `(display, window, op)`.
`_parseGrabArgs` aceita as duas.

**Leitura do SHIFT:** a extensão tenta `ClutterSeat.get_pointer().get_modifier_state()`.
Se esse método não estiver disponível, usa `global.get_pointer()`, que lê o
estado do servidor X e funciona mesmo durante o arrasto, quando o Muffin está
capturando o mouse.

### Aplicação do snap

O snap roda num `GLib.idle_add`, depois que o Muffin termina de processar o fim
do arrasto. Se rodasse dentro do próprio `grab-op-end`, o Muffin poderia
sobrescrever a geometria logo em seguida.

Antes de redimensionar, a janela sai da maximização e do encaixe nativo do
Cinnamon (`unmaximize`), porque uma janela maximizada não aceita
redimensionamento. Depois vêm `move_resize_frame()` e um `move_frame()` final,
na mesma ordem usada pelo gTile, para garantir a posição mesmo se o Muffin
ajustar o tamanho.

### Preview

- **Atualização:** um `GLib.timeout_add` de 30 ms roda enquanto o arrasto dura.
  O sinal `position-changed` não bastaria, porque só dispara quando a janela se
  move: com ele, pressionar o SHIFT com o mouse parado não mostraria nada. O
  destino só é recalculado quando o ponteiro muda de posição.
- **Elemento visual:** é um `St.Widget` com estilo CSS em linha (fundo
  translúcido, borda de 2 px, `box-shadow` para o brilho). Ele fica no
  `global.window_group`, logo abaixo do ator da janela arrastada: aparece sobre
  as outras janelas sem cobrir a que está em movimento. Como o Muffin reordena
  esse grupo quando o empilhamento das janelas muda, a posição é reaplicada a
  cada atualização.
- **Animação:** usa as transições implícitas do Clutter
  (`save_easing_state`, `set_easing_mode(EASE_OUT_CUBIC)`,
  `set_easing_duration`, `restore_easing_state`). Se o destino mudar no meio de
  uma animação, a próxima parte da geometria atual.
- **Destruição:** o widget é destruído na hora em que o SHIFT é solto, quando o
  arrasto termina (antes do snap), quando a janela é fechada durante o arrasto
  e no `disable()`.

### Configurações

O `settings-schema.json` define os controles: `colorchooser`, `scale`,
`spinbutton` e títulos `header`. No `enable()`, a extensão cria um
`Settings.ExtensionSettings(_config, uuid)` e liga cada chave a uma propriedade
de `_config` com `bind()`. O Cinnamon atualiza `_config` quando o usuário muda
algo, e o código sempre lê os valores atuais de lá. No `disable()`,
`finalize()` desfaz essa ligação.

O seletor de cor pode devolver `rgb(...)`, `rgba(...)` ou `#rrggbb`.
`_parseRgb` extrai os componentes para montar o brilho com transparência
própria.

**Pegadinha:** a janela de Extensões (`cinnamon-settings`) decide se mostra a
engrenagem uma vez só, quando monta a lista. Reiniciar o Cinnamon com
`Alt+F2` → `r` não reinicia essa janela. Se a engrenagem não aparecer depois de
criar ou renomear o `settings-schema.json`, encerre o processo
(`pkill -f cinnamon-settings`) e abra a janela de novo.

## Depuração

Cada etapa é registrada com o prefixo `[VoidSnap]`:

- **Looking Glass:** `Alt+F2`, digite `lg`, aba *Log*.
- **Arquivo:** `~/.xsession-errors`.

Exemplo de linha de snap:

```
snap "Vivaldi" -> monitor 1, preenchendo área livre área=(2560,800 1080x1760) alvo=(2560,800 1080x1760) obtido=(2560,800 1080x1760)
```

Se `obtido` for diferente de `alvo`, a aplicação impôs um tamanho mínimo (veja
a seção 6).

Para recarregar depois de editar o código, desative e ative a extensão em
*Extensões*, ou reinicie o Cinnamon com `Alt+F2` → `r`.

## Limitações conhecidas

- Testada apenas em sessão X11, que é o padrão do Cinnamon. A sessão Wayland
  experimental não foi testada.
- O espaço livre é sempre preenchido inteiro. Não há como dividi-lo em zonas
  quando já existem obstáculos.
- Se a janela for solta com o ponteiro sobre outra janela, o snap usa as zonas
  da tela inteira e pode cobrir essa janela.
- Janelas soltas no meio da tela, mesmo pequenas, também são obstáculos e
  podem reduzir bastante o espaço livre.

## Desenvolvimento e Créditos

Este projeto foi idealizado, arquitetado e validado por **Wesley Prado**. O desenvolvimento do código, a refatoração geométrica e a estruturação dos manifestos foram realizados em parceria colaborativa com agentes autônomos de Inteligência Artificial (**Claude Code Pro**).

## Licença

Distribuído sob a licença MIT. Veja [LICENSE](LICENSE).
