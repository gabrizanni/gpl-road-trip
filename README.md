# GPL Road Trip

Web app gratuita e installabile per il viaggio **Bazzano (PR) → Aeroporto di Bologna → Perugia → Cisternino** del 16–17 agosto. Mostra il percorso e ordina i distributori GPL usando lo snapshot MIMIT incluso nel sito.

Non usa ChatGPT, account, server applicativi o chiavi API. Dopo la prima apertura conserva sul dispositivo l’interfaccia, le tappe e l’ultimo elenco GPL scaricato. Google Maps, traffico e cartografia richiedono una connessione.

## Pubblicazione gratuita su GitHub Pages

1. Crea un repository GitHub vuoto e carica **il contenuto di questa cartella** nella radice del repository.
2. In GitHub apri **Settings → Pages** e, in **Build and deployment**, seleziona **GitHub Actions**.
3. Apri la scheda **Actions**: il workflow prova subito ad aggiornare i dati MIMIT e pubblica il sito. Se il download non risponde, mantiene lo snapshot iniziale e riprova automaticamente ogni giorno. Otterrai un indirizzo simile a `https://nomeutente.github.io/nome-repository/`.
4. Apri quell’indirizzo una volta sul telefono mentre sei online, seleziona entrambi i giorni e lascia caricare la mappa. Così l’app e i dati correnti vengono salvati anche per l’uso offline.

Il sito è composto solo da file statici, quindi può essere pubblicato anche su Cloudflare Pages, Netlify Drop o qualunque hosting statico gratuito. Va servito in **HTTPS**: aprire direttamente `index.html` come file non permette l’installazione PWA e l’aggiornamento offline.

## Installazione

- **Android:** apri il sito con Chrome, tocca **Installa app** oppure **⋮ → Aggiungi a schermata Home**.
- **iPhone/iPad:** apri con Safari, tocca **Condividi → Aggiungi alla schermata Home**.
- **Windows:** apri con Edge o Chrome e usa l’icona **Installa** nella barra degli indirizzi o **Menu → App → Installa questo sito come app**.

## Aggiornamento dei prezzi

Il browser non interroga direttamente servizi non documentati. La pipeline inclusa scarica periodicamente i CSV ufficiali MIMIT, seleziona GPL e genera `data/latest.json`. GitHub Actions può eseguirla senza un server acceso e pubblicare automaticamente il nuovo snapshot.

Il pulsante **Aggiorna** nell’app scarica l’ultimo snapshot già pubblicato. È opportuno aprire l’app e toccarlo prima della partenza e al mattino del 17 agosto.

I prezzi MIMIT non attestano gli orari di apertura. Prima di deviare, controlla la scheda su Maps o chiama il distributore; durante la guida deve operare il passeggero.

## Prova locale

Serve un piccolo server HTTP (l’apertura come `file://` non è sufficiente):

```bash
python3 -m http.server 8080 --directory .
```

Poi visita `http://localhost:8080`. I service worker sono consentiti su `localhost`; per un dispositivo esterno è necessario HTTPS.

## Struttura

- `index.html`, `styles.css`, `app.js`: interfaccia e logica della mappa.
- `manifest.webmanifest`, `service-worker.js`, `offline.html`: installazione e uso offline.
- `data/routes.json`: tappe e corridoi di rifornimento.
- `data/latest.json`: snapshot GPL pubblicato automaticamente.
- `data/seed.json`: dati di riserva inclusi nel pacchetto.
- `scripts/`: download, filtro e validazione dei dati MIMIT.
- `.github/workflows/`: aggiornamento dati e pubblicazione su GitHub Pages.

## Licenze e privacy

I dati dei carburanti provengono dal [dataset ufficiale MIMIT](https://www.mimit.gov.it/it/open-data/elenco-dataset/carburanti-prezzi-praticati-e-anagrafica-degli-impianti) con licenza IODL 2.0. La mappa usa OpenStreetMap e Leaflet con le rispettive attribuzioni. La web app non richiede login e non invia dati a OpenAI. La geolocalizzazione, se richiesta dall’utente, resta nel browser e serve soltanto a centrare la mappa.
