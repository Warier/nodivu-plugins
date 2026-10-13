# Nodivu Ducking

![Logo](logo.png)

Plugin nativo leve, gratuito e MIT para o [Nodivu](https://github.com/Warier/nodivu).
Processamento local em CPU, sem GPU, rede ou modelos. Versão **1.0.0**, Windows x64.

## Compatibilidade e instalação

Requer **Nodivu com contrato de plugins host_api 2** (desenvolvimento posterior à 0.2.0).
A release 0.2.0 original não suporta este pacote. O catálogo deve mostrá-lo como incompatível nela.
No host atualizado, abra **Gerenciar plugins → Explorar**, escolha este plugin e instale.
Confirme a confiança no autor, salve seu projeto e feche/abra o Nodivu.
Alternativa: baixe o ZIP em [Releases](https://github.com/Warier/nodivu-ducking/releases)
e use **Adicionar ZIP local**. Não extraia sobre uma DLL em uso.

## Como usar

1. Ligue o Player/captura de aplicativo à entrada **1 — Áudio** do Ducking.
2. Ligue o microfone à entrada **2 — Referência**. Esse áudio não sai pelo Ducking.
3. Ligue a saída do Ducking ao Mixer. Ligue também o microfone a outra entrada do Mixer.
4. Ligue o Mixer à saída física ou ao VB-CABLE. Fale: a música abaixa e volta depois da pausa.

```text
Música ──→ [1 Ducking] ──→ Mixer ──→ Saída
Mic ─────→ [2 Referência]     ↑
 └───────────────────────────┘
```

| Controle | Padrão | Efeito |
|---|---|---|
| Redução | 18 dB | Quanto abaixar a música durante atividade |
| Sensibilidade | −32 dBFS | Limiar do detector; mais negativo detecta sinais menores |
| Ataque | 15 ms | Rapidez da redução |
| Retorno | 350 ms | Suavidade da recuperação |
| Espera | 180 ms | Sustenta a redução entre sílabas |

A detecção é por nível, não reconhecimento de voz: ruído alto também aciona.
Sem referência conectada, a música passa sem redução. Sem música, a saída é silenciosa,
mesmo havendo microfone na referência. Bypass passa somente a música.


## Consumo e latência

Algoritmo constante por amostra, sem alocação, locks, arquivos ou rede no processamento.
Não adiciona fila, janela de antecipação nem atraso algorítmico declarado: **0 frames**.
Tempos de detector/rampa são resposta do controle, não um buffer que atrasa todo o áudio.
Classe **leve** é uma declaração do projeto, não garantia de CPU ou latência ponta a ponta.
A latência dos dispositivos/Windows/Nodivu permanece. Instâncias mantêm estados independentes.

## Compilar e testar

Instale Git e Visual Studio 2022 Build Tools com C++ x64 e Windows SDK; PowerShell 7 recomendado.
Não precisa compilar o Nodivu nem instalar Rust, Node ou Python para este plugin.

```powershell
git clone https://github.com/Warier/nodivu-ducking.git
cd nodivu-ducking
./scripts/Build.ps1
```

O script compila C++17 com `/O2 /W4 /WX /MT`, executa os testes DSP e gera:

- `dist/package/`: pacote importável com biblioteca CLAP, manifestos, README e licenças.
- `dist/nodivu-ducking-1.0.0-windows-x64.zip`: mesmo pacote para distribuição.
- `dist/SHA256SUMS.txt`: hash para conferir o ZIP; não equivale à assinatura Authenticode.

## Organização para autores

| Arquivo | Responsabilidade |
|---|---|
| `src/dsp.h` | Algoritmo, parâmetros e estado; independente de CLAP e do host |
| `src/clap_plugin.cpp` | ABI CLAP, lifecycle, validação e tradução de eventos/buffers |
| `plugin.json` | Aparência declarativa no bloco/inspetor; não executa HTML/JS |
| `nodivu-package.json` | Identidade, versão, plataforma e host mínimo |
| `tests/dsp_test.cpp` | Comportamento, estéreo, independência e reset |
| `scripts/Build.ps1` | Build, testes e empacotamento |
| `CONTRACT.md` | Requisitos precisos de áudio, parâmetros, host e distribuição |

[Contrato deste plugin](https://github.com/Warier/nodivu-ducking/blob/main/CONTRACT.md).
[Contrato de integração do host](https://github.com/Warier/nodivu/blob/main/PLUGIN-NATIVE.md).
O README incluído na loja pertence à mesma versão imutável do ZIP; não é o README futuro da main.

## Licença e contribuição

Código MIT; contribuições por PR são bem-vindas. CLAP 1.2.2 é MIT, com sua licença separada.
Uma DLL nativa executa com os direitos do backend: instale somente pacotes de autores confiáveis.
Mudanças publicadas exigem nova versão; nunca substitua os bytes da release 1.0.0.

