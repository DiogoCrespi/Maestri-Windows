# Open Maestri for Windows 0.1.1

Release corretivo para Windows 10 (1903+) e Windows 11.

## Correções principais

- Retomada automática da conversa de cada agente após reiniciar o aplicativo,
  usando o identificador persistido do provedor.
- Recuperação de sessões Antigravity pelos logs individuais do terminal quando
  o índice `.maestri/agent-sessions.json` estiver ausente.
- Reabertura automática do último workspace válido no início do aplicativo.
- `PATH` dos terminais normalizado com diretórios absolutos do Windows, permitindo
  que Codex, Claude e Antigravity encontrem PowerShell e executem `maestri ask`,
  `check`, `list` e os demais comandos do CLI.
- Inicialização protegida: uma falha ao recuperar a conversa não cria um chat
  novo silenciosamente.
- Executável de produção com frontend e backend nativos incorporados, sem depender
  de um servidor `localhost` iniciado manualmente.

## Como instalar

- Recomendado: execute `Open-Maestri-Windows-v0.1.1-Setup.exe`.
- Alternativa corporativa: use `Open-Maestri-Windows-v0.1.1.msi`.
- Sem instalação: extraia `Open-Maestri-Windows-v0.1.1-portable.zip` e execute
  `Open Maestri.exe`, mantendo `omaestri.exe` na mesma pasta.

## Requisitos

- Microsoft Edge WebView2 Runtime.
- Os CLIs de IA usados nos terminais, como Codex, Claude ou Antigravity.

## Limitações conhecidas

- Os artefatos ainda não possuem assinatura digital; o Windows SmartScreen pode
  exibir um aviso. Verifique os hashes em `SHA256SUMS.txt`.
- Sessões de Portal permanecem isoladas; compartilhamento derivado de conexões
  Portal-para-Portal será habilitado em uma versão futura.
