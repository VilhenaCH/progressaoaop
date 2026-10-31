# Nexo — Terminal de Progressão

Site estático (GitHub Pages) + Firebase (Auth Google + Firestore).

## Arquivos
`index.html` · `app.js` (progressão, staff, mural) · `economia.js` (resgate diário, moedas, carteira, mercados, mesa, dados) · `style.css` + `bank.css` (visual) · `icons/` (game-icons.net, CC BY 3.0 — ver `icons/license.txt`) · `firestore.rules`

## Publicar
1. Suba todos os arquivos na raiz do repositório (GitHub Pages, branch `main`, pasta `/`).
2. Firebase → Authentication → Google ativo, e o domínio do Pages em *Authorized domains*.
3. **Publique `firestore.rules`** (Console → Firestore → Regras → Publicar, ou `firebase deploy --only firestore:rules`). Sem isso as telas novas não funcionam.
4. Admins: os UIDs ficam em `ADMIN_UIDS` (app.js) **e** na função `isAdmin()` das regras — mantenha as duas listas iguais.

## Economia extra
- **Resgate diário**: 40 PP/dia; a cada 7 dias seguidos o 7º dia vale 100 PP (baú). Quebrou a sequência, a chama apaga. O dia vira à meia-noite de Brasília.
- **Moedas** (staff cria no Banco): saldos independentes do PP; jogadores trocam entre si em *Carteira → Enviar*.
- **Mercados**: cofres criados pela staff (um por contexto/mesa). Jogadores enviam moeda com motivo obrigatório; a staff paga a jogadores; há registro de tudo.
- **Resgate de mestre**: o mestre marca os jogadores da mesa e pede PP/PE (e sessão jogada) de uma vez; a staff aprova no Banco. A staff também aplica direto (*Banco → Mesa*). O PE vai ao primeiro personagem ativo de cada jogador.
- **Dados da sorte**: 6d6, 2 PP por rolagem, pote acumulado. Chance = 1/46.656 (0,0021%) + 0,01% a cada 200 PP no pote, teto 7,5%.

## Limite de segurança (importante)
Não há servidor: regras de resgate diário, carteiras e pote são conferidas pelo Firestore, mas o **sorteio dos dados roda no navegador** — quem mexer no console consegue forçar uma vitória. Serve para jogo entre amigos; se virar dinheiro "de verdade" no servidor, mova o sorteio para uma Cloud Function.
