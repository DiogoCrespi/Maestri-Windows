# Open Maestri for Windows 0.1.0

Primeiro release público para Windows 10 (1903+) e Windows 11.

## Destaques

- Canvas espacial persistente para terminais, notas, arquivos e portais web.
- Terminais nativos via ConPTY para PowerShell, CMD, WSL e shells personalizados.
- Coordenação entre agentes conectados, com resolução por nome, UUID ou ID do canvas.
- Protocolo correlacionado de solicitação e resposta no `omaestri ask`/`reply`.
- Projetos, rotinas, perfis de agentes, Git worktrees (Floors) e sessões SSH remotas.
- Distribuição por instalador EXE, MSI ou ZIP portátil.

## Como instalar

- Recomendado: execute `Open-Maestri-Windows-v0.1.0-Setup.exe`.
- Alternativa corporativa: use `Open-Maestri-Windows-v0.1.0.msi`.
- Sem instalação: extraia o ZIP portátil e execute `Open Maestri.exe`, mantendo
  `omaestri.exe` na mesma pasta.

## Requisitos

- Microsoft Edge WebView2 Runtime.
- Os CLIs de IA que serão usados nos terminais, como Codex, Claude ou Antigravity.

## Limitações conhecidas

- Os artefatos ainda não possuem assinatura digital; o Windows SmartScreen pode
  exibir um aviso. Verifique os hashes em `SHA256SUMS.txt`.
- O histórico visual do terminal é restaurado, mas a conversa do provedor de IA
  ainda não é retomada automaticamente depois que o aplicativo é encerrado.
- Sessões de Portal permanecem isoladas; compartilhamento derivado de conexões
  Portal-para-Portal será habilitado em uma versão futura.
