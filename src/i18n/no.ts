/**
 * Norwegian UI strings. This file is the typed source of truth for every
 * string in the app: `MessageKey` is derived from it, and `en.ts` must satisfy
 * the same keys, so a missing translation is a compile error.
 *
 * Placeholders use `{name}` and are substituted by `t()`.
 */
export const no = {
  'app.name': 'TruHiker',
  'app.tagline': 'GPX-analyse for norske fjell',
  'app.metaDescription':
    'Analyser GPX-ruter for norsk fjellterreng: 3D-kart, høydeprofil, stigning og estimert gangtid. Ruten blir i nettleseren.',
  'app.loading': 'Laster …',
  'action.more': 'Mer',

  'action.openGpx': 'Åpne GPX',
  'action.demo': 'Prøv demoruten',
  'action.retry': 'Prøv igjen',
  'action.close': 'Lukk',
  'action.dismiss': 'Lukk',
  'action.collapse': 'Skjul høydeprofil',
  'action.expand': 'Vis høydeprofil',
  'action.share': 'Kopier lenke til ruten',
  'action.about': 'Om data',
  'action.save': 'Lagre',
  'action.reset': 'Tilbakestill',
  'action.fitRoute': 'Vis hele ruten',

  'lang.label': 'Språk',
  // The visible text on the buttons is "NO"/"EN", so it must appear in the
  // accessible name too (WCAG 2.5.3). Parentheses are stripped before the
  // comparison, so the code is a bare word rather than "Norsk (NO)".
  'lang.no': 'Norsk – NO',
  'lang.en': 'Engelsk – EN',

  'layers.label': 'Kartlag',
  'layers.topo': 'Topo',
  'layers.grey': 'Grå',
  'layers.wms': 'WMS',

  'demo.title': 'Om demoruten',
  'demo.name': 'Rute',
  'demo.number': 'Rutenummer',
  'demo.maintainer': 'Vedlikeholdes av',
  'demo.marked': 'Merking',
  'demo.markedYes': 'Merket på bakken',
  'demo.source': 'Kilde',
  'demo.sourceValue': 'Kartverket Turrutebasen, CC BY 4.0',
  'demo.note':
    'Ruten er ekte stigeometri fra Turrutebasen, uten høyde i filen. Høydeprofilen hentes direkte fra Kartverket DTM.',

  'terrain.toggle': '3D',
  'terrain.enable': 'Vis terrenget i 3D',
  'terrain.disable': 'Vis kartet flatt',
  'terrain.loading': 'Laster terreng …',
  'terrain.unavailable': '3D-terreng er utilgjengelig',
  'terrain.failedDetail':
    'Terrengdata fra Mapterhorn kunne ikke hentes, så kartet vises flatt. Høydeprofilen er ikke påvirket.',

  'route.demo': 'Demorute',
  'route.demoDetails': 'Vis informasjon om demoruten',
  'route.file': 'Fra fil',
  'route.link': 'Delt rute',
  'route.unnamed': 'Uten navn',
  'route.loaded': 'Ruten «{name}» er lastet.',
  'route.none': 'Ingen rute',

  'profile.title': 'Høydeprofil',
  'profile.empty': 'Ingen rute lastet',
  'profile.emptyHint': 'Slipp en GPX-fil på kartet for å se høydeprofilen.',
  'profile.loading': 'Henter høydedata … {done} av {total} fliser',
  'profile.loadingShort': 'Henter høydedata …',
  'profile.unavailable': 'Høydedata utilgjengelig',
  'profile.unavailableDetail':
    'Kartverkets høydedata (DTM) kunne ikke hentes. Høyde, stigning, nedstigning og gangtid er slått av – ikke satt til null.',
  'profile.outOfScope': 'Ruten går utenfor Norge, der høydedata ikke er tilgjengelig.',
  'profile.filled': '{n} punkter manglet høyde og er interpolert.',
  'profile.fetched': 'Høydedata hentet {time}',
  'profile.fetchedFilled': '{n} punkter interpolert · hentet {time}',
  'profile.ariaLabel':
    'Høydeprofil. Bruk piltastene for å flytte markøren, Home og End for start og slutt.',
  'profile.ariaValue': '{distance} fra start, {ele} over havet, stigning {grade}',
  'profile.cursorDistance': 'Fra start',
  'profile.cursorElevation': 'Høyde',
  'profile.cursorGrade': 'Stigning',
  'profile.min': 'Min {value}',
  'profile.max': 'Maks {value}',
  'profile.axisDistance': 'Avstand',
  'profile.flatten': 'Vis flatt',
  'profile.flattenHint': 'Vis høydeprofilen uten terrengforming (samme tall, flat linje)',

  'stats.distance': 'Distanse',
  'stats.ascent': 'Stigning',
  'stats.descent': 'Nedstigning',
  'stats.time': 'Gangtid',
  'stats.elevation': 'Høyde',
  'stats.elevationSource': 'Høydedatakilde',
  'stats.pace': 'Juster gangtempo',
  'stats.disabled': 'Utilgjengelig – krever høydedata',
  'stats.range': '{min}–{max}',
  'stats.timeHint': 'Naismith: {speed} km/t på flatt, pluss 1 time per {ascent} m stigning.',
  'stats.overallGrade': 'Snittstigning {grade}',

  'source.ready': 'Kartverket DTM',
  'source.none': 'Ingen rute',
  'source.loading': 'Henter …',
  'source.error': 'Utilgjengelig',
  'source.title':
    'Kartverket DTM (terrengmodell uten bygg og vegetasjon) via hoydedata.no – CC BY 4.0',

  'pace.title': 'Gangtempo',
  'pace.intro':
    'Gangtiden følger Naismiths regel: en grunnhastighet på flatt, pluss ekstra tid for hver høydemeter oppover. Juster de to tallene til din egen fart.',
  'pace.speedLabel': 'Grunnhastighet (km/t)',
  'pace.ascentLabel': 'Stigningstempo (m/t)',
  'pace.formula': 'Tid = distanse ÷ {speed} km/t + stigning ÷ {ascent} m/t.',
  'pace.invalid': 'Oppgi et tall mellom {min} og {max}.',
  'pace.saved': 'Tempo lagret: {speed} km/t og {ascent} m/t.',

  'save.dirty': 'ikke lagret',
  'save.saving': 'lagrer …',
  'save.saved': 'lagret {time}',
  'save.quota': 'Lagring mislyktes: nettleserlagringen er full. Last ned turen som GPX i stedet.',
  'save.quotaSize':
    'Lagring mislyktes: turen er {size}, og nettleserlagringen er full. Last den ned som GPX i stedet.',
  'save.error': 'Lagring mislyktes: {message}',
  'save.unavailable': 'Lagring er utilgjengelig i denne nettleseren',
  'save.hint': 'Lagre turen (Ctrl+S eller ⌘S)',

  'store.quota':
    'Nettleserlagringen er full. Last ned turen som GPX, eller slett en gammel tur, og prøv igjen.',
  'store.quotaSize':
    'Nettleserlagringen er full: turen er {size}. Last den ned som GPX, eller slett en gammel tur, og prøv igjen.',
  'store.corrupt': 'De lagrede turene kunne ikke leses fordi dataene er skadet.',
  'store.unsupported':
    'Nettleseren tillater ikke lagring her. Det skjer i privat modus eller når lagring er blokkert.',
  'store.notFound': 'Turen finnes ikke lenger.',
  'store.generic': 'Noe gikk galt: {message}',
  'store.indexUnreadable': 'Turbiblioteket kunne ikke leses.',

  'trips.open': 'Turer',
  'trips.title': 'Lagrede turer',
  'trips.empty':
    'Ingen turer er lagret ennå. Åpne en GPX-fil eller tegn en rute, så lagres den automatisk her.',
  'trips.untitled': 'Uten navn',
  'trips.updated': 'Oppdatert {date}',
  'trips.legCount': '{n} {unit}',
  'trips.unitLegOne': 'etappe',
  'trips.unitLegMany': 'etapper',
  'trips.unknownDistance': 'Distanse ukjent',
  'trips.openAction': 'Åpne',
  'trips.rename': 'Gi nytt navn',
  'trips.renameSave': 'Lagre navn',
  'trips.renameCancel': 'Avbryt',
  'trips.renameLabel': 'Nytt navn',
  'trips.duplicate': 'Dupliser',
  'trips.duplicateSuffix': '(kopi)',
  'trips.delete': 'Slett',
  'trips.deleteConfirm': 'Slette «{name}»? Det kan ikke angres.',
  'trips.exportGpx': 'Eksporter GPX',
  'trips.exportGeoJson': 'Eksporter GeoJSON',
  'trips.import': 'Importer fil',
  'trips.newTrip': 'Ny tur',
  'trips.newTripName': 'Ny tur',
  'trips.dropHint': 'Slipp en GPX- eller GeoJSON-fil her, eller velg en fil.',
  'trips.imported': 'Turen «{name}» er importert.',
  'trips.importFailed': 'Importen mislyktes: {message}',
  'trips.current': 'åpen nå',
  'trips.settings': 'Turinnstillinger',
  'trips.engineMissing': 'Turbiblioteket er utilgjengelig i denne versjonen.',
  'trips.actionsFor': 'Handlinger for {name}',

  'storage.indexeddb': 'IndexedDB',
  'storage.localstorage': 'localStorage',
  'storage.usage': '{used} av ~{quota} brukt',
  'storage.persistent': 'varig lagring',
  'storage.notPersistent': 'kan ryddes av nettleseren',
  'storage.fallback':
    'IndexedDB er utilgjengelig, så turene lagres i localStorage. Hver tur kan være opptil 1,5 MB; større turer kan ikke lagres før dette virker.',
  'storage.migrated': '{n} turer flyttet fra localStorage',
  'storage.migrationFailed':
    'Turer fra localStorage kunne ikke flyttes. De ligger fortsatt i localStorage.',

  'weather.open': 'Vær',
  'weather.title': 'Vær langs ruten',
  'weather.refresh': 'Oppdater',
  'weather.fetched': 'varsel hentet {time}',
  'weather.issued': 'varsel sendt {time}',
  'weather.horizonNote':
    'MET sitt varsel dekker omtrent {days} døgn fremover. Dager utenfor horisonten vises uten tall – ingen anslag.',
  'weather.summary': '{forecast} {forecastUnit} med varsel, {beyond} {beyondUnit} utenfor horisonten',
  'weather.summaryAll': '{forecast} {forecastUnit} med varsel',
  'weather.unitDayOne': 'dag',
  'weather.unitDayMany': 'dager',
  'weather.noneInHorizon': 'Ingen dager ligger innenfor varselhorisonten.',
  'weather.empty': 'Turen har ingen dager å vise vær for.',
  'weather.loading': 'Henter varsel …',
  'weather.loadingDay': 'henter …',
  'weather.failed': 'Værvarselet er ikke tilgjengelig: {message}',
  'weather.noForecast': 'Værvarselet er ikke tilgjengelig. Prøv Oppdater.',
  'weather.networkError': 'nettverket svarte ikke',
  'weather.beyondHorizon': 'utenfor varselhorisonten',
  'weather.dayUnavailable': 'ikke tilgjengelig',
  'weather.noValues': 'ingen verdier',
  'weather.noTrip': 'Last en rute først, så vises været for hver dag.',
  // D12: alerts are deliberately not implemented, and silence is not safety.
  'weather.alertsUnsupported':
    'Varsler om skred, flom og uvær er ikke støttet i denne versjonen. Fravær av varsel betyr ikke at det er trygt.',
  'weather.engineMissing': 'Værmodulen er ikke tilgjengelig i denne versjonen.',
  'weather.needsStartDate':
    'Værvinduet trenger en startdato. Åpne turinnstillingene og fyll inn startdato og kilometer per dag.',
  'weather.needsDailyKm':
    'Værvinduet trenger kilometer per dag. Åpne turinnstillingene og fyll inn hvor langt du går hver dag.',
  'weather.openSettings': 'Åpne turinnstillinger',
  'weather.rowAria': 'Dag {day}, {date}: {values}',
  'weather.rowAriaBadge': 'Dag {day}, {date}: {badge}',
  'weather.warnings': 'Varsler',
  'weather.warningLink': 'Les varselet',
  'weather.fromDistance': '{distance} fra start',
  'weather.colDay': 'Dag',
  'weather.colDate': 'Dato',
  'weather.colDistance': 'Distanse',
  'weather.colConditions': 'Vær',
  'weather.sym.clear': 'klart',
  'weather.sym.fair': 'lettskyet',
  'weather.sym.partlyCloudy': 'delvis skyet',
  'weather.sym.cloudy': 'skyet',
  'weather.sym.fog': 'tåke',
  'weather.sym.rain': 'regn',
  'weather.sym.sleet': 'sludd',
  'weather.sym.snow': 'snø',
  'weather.sym.thunder': 'torden',
  'weather.sym.unknown': 'ukjent symbol',
  'weather.severity.minor': 'mindre',
  'weather.severity.moderate': 'moderat',
  'weather.severity.severe': 'alvorlig',
  'weather.severity.extreme': 'ekstrem',
  'weather.severity.unknown': 'ukjent alvorlighetsgrad',

  'editor.title': 'Ruteredigering',
  'editor.mode': 'Modus',
  'editor.view': 'Vis',
  'editor.draw': 'Tegn',
  'editor.edit': 'Rediger',
  'editor.undo': 'Angre',
  'editor.redo': 'Gjør om',
  'editor.snap': 'Snapp til sti',
  'editor.radius': 'Radius',
  'editor.snapOn': 'snapper til {route}',
  'editor.snapOff': 'ingen sti innenfor {radius} m',
  'editor.snapDisabled': 'snapping er av',
  'editor.snapLoading': 'henter stinett …',
  'editor.snapFailed': 'stinettet er ikke tilgjengelig',
  'editor.snapIdle': 'stinettet lastes når du tegner eller redigerer',
  'editor.snapReady': 'stinettet er lastet – før musepekeren over kartet for å se hva den snapper til',
  // "avstikk" is the plan's detour (supply.detourValue); geometry that leaves a
  // mapped trail is "utenfor sti", so the two cannot be read as the same thing.
  'editor.offTrail': '{count} strekninger utenfor sti',
  'editor.offTrailNone': 'hele ruten følger registrerte stier',
  'editor.offTrailUnknown': 'strekninger utenfor sti er ikke beregnet – stinettet er ikke lastet',
  'editor.offTrailSnapOff': 'strekninger utenfor sti beregnes når snapping er på',
  'editor.offTrailSpan': 'Utenfor sti {n}: {from}–{to}',
  'editor.deleteVertex': 'Slett punkt',
  'editor.split': 'Del etappe',
  'editor.reverse': 'Snu etappe',
  'editor.trim': 'Klipp til',
  'editor.deleteLeg': 'Slett etappe',
  'editor.legName': 'Etappenavn',
  'editor.renameApply': 'Lagre navn',
  'editor.reroute': 'Fest til sti',
  'editor.rerouteHint':
    'Fest til sti flytter punktene i den valgte strekningen til nærmeste turrute innenfor radiusen og erstatter sammenhengende stykker med stiens linje – den finner ikke nye veier, og der ingen sti er nær nok blir punktet stående som utenfor sti.',
  'editor.rerouteNeedsSnap': 'Fest til sti krever at stinettet er lastet.',
  'editor.route': 'Rute',
  'editor.routeHint': 'Finn en rute mellom to punkter langs Turrutebasen',
  'route.pickStart': 'Klikk startpunktet på kartet. Escape avbryter.',
  'route.pickEnd': 'Klikk målpunktet.',
  'route.loading': 'Henter stinett og beregner rute …',
  'route.done': 'Rute lagt inn: {distance}.',
  'route.noTrailStart': 'Ingen sti innen {radius} av startpunktet.',
  'route.noTrailEnd': 'Ingen sti innen {radius} av målpunktet.',
  'route.noPath': 'Stinettet henger ikke sammen mellom punktene.',
  'route.areaTooLarge': 'Området er for stort for ruting. Flytt punktene nærmere hverandre.',
  'route.tooManyFeatures': 'For mange stier i området. Flytt punktene nærmere hverandre.',
  'route.networkUnavailable': 'Stinettet er utilgjengelig: {detail}',
  'route.needsLeg': 'Åpne eller tegn en etappe først.',
  'route.failed': 'Ruten kunne ikke legges inn.',
  'editor.rerouteNoTrail':
    'Fant ingen sti innenfor radiusen. Strekningen er uendret og markert som utenfor sti.',
  'editor.selectHint':
    'Klikk et punkt for å velge det. Skift-klikk et annet punkt for å velge en strekning.',
  'editor.drawHint': 'Klikk på kartet for å legge til punkter.',
  'editor.viewHint': 'Bytt til Rediger for å flytte punkter, eller Tegn for å legge til nye.',
  'editor.engineMissing': 'Redigering er ikke tilgjengelig i denne versjonen.',
  'editor.noTrip': 'Ingen etapper å redigere.',
  'editor.vertexCount': '{n} punkter',
  'editor.selection': '{leg}: punkt {from} av {total}',
  'editor.selectionSpan': '{leg}: punkt {from}–{to}',
  'editor.legFallback': 'Etappe {n}',
  'editor.offTrailBadge': 'utenfor sti',

  'settings.title': 'Turinnstillinger',
  'settings.intro':
    'Dette er dine tall, ikke antakelser om deg. Verdiene brukes bare til å beregne energi, mat og dagslengder for denne turen.',
  'settings.bodyTitle': 'Kropp',
  'settings.mass': 'Vekt (kg)',
  'settings.height': 'Høyde (cm)',
  'settings.age': 'Alder (år)',
  'settings.sex': 'Kjønn',
  'settings.sexMale': 'Mann',
  'settings.sexFemale': 'Kvinne',
  'settings.bodyFat': 'Kroppsfett (%) – valgfritt',
  'settings.bodyFatHint':
    'Valgfritt. Brukes til å beregne energiforbruk mer presist; la det stå tomt hvis du ikke vet.',
  'settings.supportTitle': 'Bæring og støtte',
  'settings.pack': 'Basevekt i sekk (kg)',
  'settings.support': 'Forsyningsmodell',
  'settings.carryAll': 'Bær alt selv',
  'settings.mailDrops': 'Mat sendes i forveien',
  'settings.paceTitle': 'Dagsdistanse',
  'settings.dailyKm': 'Kilometer per dag',
  'settings.dailyHours': 'Timer per dag',
  'settings.startDate': 'Startdato',
  'settings.startDateHint':
    'Startdato brukes til værvinduet. La den stå tom hvis du ikke har bestemt deg – da sier værvinduet fra om det.',
  'settings.dailyKmHint':
    'Kilometer per dag brukes til å finne hvilket punkt du er på hver dag i værvinduet.',
  'settings.numberRequired': 'Oppgi et tall.',
  'settings.outOfRange': 'Oppgi en verdi mellom {min} og {max}.',
  'settings.dateInvalid': 'Oppgi en gyldig dato (ÅÅÅÅ-MM-DD) eller la feltet stå tomt.',
  'settings.sexRequired': 'Velg ett alternativ.',
  'settings.supportRequired': 'Velg en forsyningsmodell.',
  'settings.saved': 'Turinnstillingene er lagret.',
  'settings.missingTrip': 'Åpne eller last en rute før du endrer turinnstillingene.',
  'settings.engineMissing': 'Turinnstillinger er ikke tilgjengelige i denne versjonen.',

  'banner.enginesMissing':
    'Turbibliotek, vær og ruteredigering er utilgjengelige i denne versjonen. Kart og høydeprofil virker som før.',
  'banner.tripSaveFailed': 'Turen kunne ikke lagres: {message}',
  'banner.importFailed': 'Filen kunne ikke importeres: {message}',
  'banner.tripBuildFailed': 'Turen kunne ikke opprettes fra ruten: {message}',

  'about.met': 'Vær: MET Norway Locationforecast 2.0 (CC BY 4.0 / NLOD).',
  'about.metLink': 'api.met.no',

  'banner.basemapFallback':
    'Kartflisene fra Kartverkets hurtigbuffer svarte ikke. Viser WMS-kart fra Geonorge i stedet.',
  'banner.basemapFailed':
    'Kartflisene er utilgjengelige. Ruten og høydeprofilen virker fortsatt, men bakgrunnskartet mangler.',
  'banner.basemapRetry': 'Prøv hurtigbufferen for kartfliser igjen',
  'banner.terrainFailed':
    '3D-terreng er utilgjengelig fordi Mapterhorn ikke svarte. Kartet vises flatt.',
  'banner.demoFailed': 'Demoruten kunne ikke lastes. Åpne en GPX-fil i stedet.',
  'banner.gpxError': 'Kunne ikke lese GPX-filen: {message}',
  'banner.noTrack': 'Filen inneholder ingen spor eller ruter.',
  'banner.tooShort': 'Ruten er for kort til å analysere (minst to punkter trengs).',
  'banner.hashTooLong':
    'Ruten er for lang til å deles via lenken (maks {max} tegn). Åpne filen i stedet.',
  'banner.hashInvalid': 'Lenken inneholder en rute som ikke kunne leses.',
  'banner.shareCopied': 'Lenke til ruten er kopiert.',
  'banner.shareFailed': 'Kunne ikke kopiere lenken. Kopier adressen fra nettleseren i stedet.',
  'banner.offScope': 'Ruten går utenfor Norge – høydeprofil og statistikk er utilgjengelige.',
  'banner.demFailed': 'Høydedata er utilgjengelig: {message}',
  'banner.workerFailed': 'Høydeberegningen stoppet: {message}',
  'banner.welcome': 'Kartet er klart.',
  'banner.fileTooLarge': 'Filen er for stor ({size} MB). Maks {max} MB.',
  'banner.mapFailed': 'Kartet kunne ikke starte: {message}',

  'empty.title': 'Slipp en GPX-fil her',
  'empty.body':
    'eller åpne en fil fra menyen. Ruten blir i nettleseren din – ingen konto, ingenting lastes opp.',
  // B4: the route itself never leaves the browser, but positions from it are
  // sent to fetch elevation, trails and weather. Say both, precisely.
  'empty.privacy':
    'Ruten lagres bare i denne nettleseren. For å hente høydedata, stier, vær og 3D-terreng sender appen posisjoner fra ruten til Kartverket, MET, hoydedata.no og Mapterhorn. Ingen konto, ingen sporing.',

  'map.ariaLabel': 'Kart over ruten. Bruk piltastene for å panorere og + og − for å zoome.',
  'map.zoomIn': 'Zoom inn',
  'map.zoomOut': 'Zoom ut',
  'map.resetNorth': 'Rett kartet mot nord',
  'about.shortDisclaimer': 'Planleggingsverktøy – ikke navigasjon',

  'units.metre': 'm',
  'units.metresAboveSea': 'moh',
  'units.kilometre': 'km',
  'units.durationHours': '{h} t {m} min',
  'units.durationHoursOnly': '{h} t',
  'units.durationMinutes': '{m} min',
  'units.grade': '{value} %',

  'about.title': 'Om data og bruk',
  'about.disclaimerTitle': 'Planleggingsverktøy – ikke navigasjon',
  'about.disclaimer':
    'Dette er et planleggingsverktøy. Sjekk forholdene på bakken: vær, snø, elvekryssinger og stengsler endrer seg. Tallene er estimater.',
  'about.dataTitle': 'Datakilder',
  'about.kartverket': 'Bakgrunnskart og høydedata: Kartverket (topo, DTM), CC BY 4.0.',
  'about.mapterhorn': '3D-terreng: Mapterhorn, avledet av Kartverkets høydedata.',
  'about.turrutebasen': 'Demorute: Kartverket Turrutebasen (jot21), CC BY 4.0.',
  'about.maplibre': 'Kartmotoren er MapLibre GL JS (BSD-3).',
  'about.naismith':
    'Gangtid etter Naismiths regel med justerbart tempo. Stigning og nedstigning er hysterese-filtrert for å dempe støy i høydedata.',
  'about.demo':
    'Demoruten er Memurubu–Glitterheim (jot21) fra Kartverket Turrutebasen, vedlikeholdt av DNT Oslo og omegn. Den er ekte stigeometri, ikke en syntetisk linje.',
  'about.version': 'Versjon {version} · bygget med MapLibre GL JS',
  'about.licence': 'Lisens',
  'about.kartverketLink': 'kartverket.no',
  'about.mapterhornLink': 'mapterhorn.com',
  'about.maplibreLink': 'maplibre.org',
  'about.osm':
    'Forsyningspunkter (butikker, bensinstasjoner, post): © OpenStreetMap-bidragsyterne, ODbL 1.0. Filen er en avledet database og kan lastes ned.',
  'about.osmLink': 'openstreetmap.org/copyright',
  'about.odblLink': 'ODbL 1.0',
  'about.osmNote':
    'Forsyningspunktene er et OSM-uttrekk av butikker, bensinstasjoner og postpunkt. Åpningstider er ikke lagret i filen, bare hvorvidt OSM hadde dem.',
  'about.privacyTitle': 'Lagring og personvern',
  'about.privacy':
    'Tur og rute lagres bare i denne nettleseren (IndexedDB, med localStorage som reserve). Det finnes ingen konto, og turen lastes ikke opp. For å hente stier, butikker, høydedata, vær og 3D-terreng sender appen posisjoner fra ruten til Kartverket (Turrutebasen og bakgrunnskart), MET, hoydedata.no og Mapterhorn. Ingen sporing og ingen analyseverktøy; kartflisene lastes fra den kilden du velger.',

  // --- Resupply and energy (docs/13) --------------------------------------
  'supply.open': 'Forsyning',
  'supply.title': 'Forsyning og energi',
  'supply.tabResupply': 'Forsyning',
  'supply.tabEnergy': 'Energi',
  'supply.radius': 'Korridor',
  'supply.radiusOption': '{km} km',
  'supply.radiusHint':
    'Punkter innenfor korridoren rundt ruten. Standard er 5 km; øk den for å se hva som finnes i nærheten. Hytter hentes alltid innenfor 5 km. Avstikkeren fra ruten vises per punkt og legges ikke til distansen.',
  'supply.refresh': 'Oppdater',
  'supply.legsTitle': 'Etapper',
  'supply.warningsTitle': 'Forbehold',
  'supply.engineWarnings': 'Maskinelle merknader (engelsk, uendret)',
  'supply.pointsTitle': 'Punkter langs ruten',
  'supply.noTrip': 'Ingen tur er lastet. Åpne en GPX-fil eller prøv demoruten.',
  'supply.noRoute': 'Turen har ingen rutegeometri, så det er ingen korridor å lete i.',
  'supply.noProfile':
    'Profilen mangler kroppsdata. Uten vekt, høyde og alder kan ikke kcal per dag beregnes, og da kan ikke matmengden per etappe regnes ut.',
  'supply.loading': 'Laster forsyningspunkter …',
  'supply.indexFailed':
    'Butikkdataene kunne ikke lastes ({message}). Ingenting vises – det betyr ikke at det ikke finnes butikker.',
  'supply.planFailed': 'Forsyningsplanen kunne ikke bygges ({message}).',
  'supply.countOne': '{count} punkt langs ruten',
  'supply.countMany': '{count} punkter langs ruten',
  'supply.fetched': 'hentet {time}',
  'supply.indexLine': 'OpenStreetMap-uttrekk {date} · {count} punkter · ODbL 1.0',
  'supply.mailDrop':
    'Pakke til {name}: ankomst {arrival}, send mellom {notBefore} og {shipBy} (hentefrist {window} døgn).',
  'supply.worstGap': 'Lengste strekning uten forsyning: {distance} · {days}',
  'supply.hutsFailed':
    'Hytter kunne ikke hentes ({message}). Butikkene under er komplette, men hytter mangler i oversikten.',
  'supply.totals': 'Totalt {kg} kg mat · {cost} kr · {days}',
  'supply.empty':
    'Ingen forsyningspunkter innenfor {radius} av ruten. Øk korridoren for å se hva som finnes i nærheten.',
  'supply.gapWarning': '{name}: {days} uten forsyning krever {kg} kg mat.',
  'supply.detourOnRoute': 'på ruten',
  'supply.detourValue': '{distance} fra ruten',
  'supply.gapValue': '{distance} · {days}',
  'supply.legTitle': '{from} → {to}',
  'supply.anchorStart': 'Start',
  'supply.anchorEnd': 'Slutt',
  'supply.legNumbers': '{distance} · {days} · {kcal} kcal · {kg} kg mat · {cost} kr',
  'supply.carryWarning': 'Bær {kg} kg i {days}. Du kan bære mat for høyst {max} dager.',
  // D14: with no daily distance the plan assumes one, and says so on screen.
  'supply.warnDailyKmFallback':
    'Ingen kilometer per dag er satt i turinnstillingene, så planen antar {km} km per dag. Hver dagberegning under bygger på den antakelsen.',
  'supply.warnBridged':
    '{km} km av turen er rett linje mellom etapper som ikke møtes. Strekningen er regnet som gangtid, men er ikke en registrert sti.',
  // D13: a station with no "unmanned" flag is assumed staffed — and named.
  'supply.warnStaffedFuel':
    'Bensinstasjoner antatt bemannet: {names} ({count}). Sjekk at ingen er en kortautomat, og regn bare med enkel butikkmat.',
  'supply.warnClosedOnArrival':
    '{name}: stengt på beregnet ankomstdato {date}. Sjekk åpningstidene før du planlegger rundt punktet.',
  'supply.warnHutsCounted':
    '{count} hytter ({names}) er tatt med som matkilde fordi du ba om det. Mat på hytte er ikke bekreftet – ha reserve.',
  'supply.warnHutOne':
    'Hytte på ruten ({names}) teller ikke som mat: om det selges mat på hytta er ikke kjent. Regn med å bære alt selv.',
  'supply.warnHutMany':
    '{count} hytter på ruten ({names}) teller ikke som mat: om det selges mat på hyttene er ikke kjent.',
  'supply.warnUnmannedFuel':
    'Ubemannet bensinstasjon ({names}) teller ikke som mat – sjekk stasjonen.',
  'supply.warnHoursAll':
    'Ingen av de {total} punktene er bekreftet åpne. Filen lagrer bare om OSM hadde åpningstider, ikke hva de er.',
  'supply.warnHoursSome':
    'Åpningstider mangler i OSM for {missing} av {total}. Ingen er bekreftet åpne. Sjekk før du planlegger rundt dem.',
  'supply.warnDetour':
    'Punkter mer enn 2 km fra ruten: {count} ({names}). Turen inn og tilbake kommer i tillegg.',
  'supply.warnPostNotFood':
    '{count} post- eller pakkepunkt selger ikke mat. De kan bare brukes som mottak: velg «mat sendes i forveien» i turinnstillingene.',
  'supply.warnGap':
    'Lengste strekning uten forsyning er {distance} ({days}): du må bære {kg} kg mat.',
  'supply.warnHutsFailed':
    'Hytter er ikke med i denne oversikten fordi tjenesten ikke svarte.',
  'supply.listMore': '{shown} og {more} flere',
  'supply.attribution':
    'Butikker, bensinstasjoner og post: © OpenStreetMap-bidragsyterne (ODbL 1.0). Hytter: ©Kartverket Turrutebasen (CC BY 4.0).',
  'supply.note':
    'Ingen punkt er bekreftet åpne. Sjekk åpningstidene før du planlegger rundt et punkt – særlig søndager og helligdager.',
  'supply.provenanceOsm': 'OSM/ODbL',
  'supply.provenanceCurated': 'Turrutebasen (CC BY 4.0)',
  'supply.provenanceChain': 'Kjede (verifisert)',
  'supply.badgeUnconfirmed': 'ikke bekreftet',
  'supply.badgeUnmanned': 'ubemannet',
  'supply.badgeHoursUnread': 'åpningstider ikke lagret',
  'supply.badgeHoursMissing': 'åpningstider ukjent',
  'supply.checkDnt': 'Sjekk hos DNT',
  'supply.dayValue': '{value} d',
  'supply.dayValueUnderTenth': '< 0,1 d',
  'supply.kind.supermarket': 'supermarked',
  'supply.kind.convenience': 'nærbutikk',
  'supply.kind.general': 'butikk',
  'supply.kind.grocery': 'dagligvare',
  'supply.kind.fuel': 'bensinstasjon',
  'supply.kind.post': 'post',
  'supply.kind.parcel': 'pakkeautomat',
  'supply.kind.hut': 'hytte',
  'supply.notFood': 'ikke mat',
  'supply.filterAll': 'Alle {count}',
  'supply.filterFood': 'Mat {count}',
  'supply.filterHuts': 'Hytter {count}',
  'supply.gapToNext': 'til neste brukbare punkt: {gap}',
  'supply.openSettings': 'Turinnstillinger',

  'energy.title': 'Energi og mat',
  'energy.noTrip': 'Ingen tur er lastet, så det er ingen dager å regne for.',
  'energy.noRoute': 'Ingen rute er lastet, så det er ingen dager å regne for.',
  'energy.noProfile':
    'Profilen mangler kroppsdata (vekt, høyde, alder), så BMR og forbrenning kan ikke beregnes.',
  'energy.elevationMissing':
    'Høydedata mangler: {reason}. Forbrenning, inntakstak og vektendring er slått av – ikke satt til null.',
  'energy.reasonDem': 'Kartverkets høydedata (DTM) kunne ikke hentes',
  'energy.reasonScope': 'ruten går utenfor Norge, der høydedata ikke finnes',
  'energy.reasonNoRoute': 'ingen rute er lastet',
  'energy.reasonLoading': 'høydedata lastes fortsatt',
  'energy.rangeTitle': 'Dagsforbrenning (TDEE)',
  'energy.rangeValue': '{low}–{high} kcal/dag',
  'energy.centreLabel': 'modellens midtpunkt {value} kcal/dag',
  'energy.ceilingLabel': 'Inntakstak {value} kcal/dag (2,5 × BMR)',
  'energy.bmrLabel': 'BMR {value} kcal/dag ({equation})',
  'energy.equation.mifflin': 'Mifflin–St Jeor',
  'energy.equation.cunningham': 'Cunningham',
  'energy.unsustainableTitle': 'Underskuddet er strukturelt uunngåelig',
  'energy.unsustainableBody':
    'Du forbrenner {tdee} kcal/dag, men inntakstaket er {ceiling} kcal/dag. Underskuddet på {deficit} kcal/dag kan du ikke spise deg bort fra, uansett hvor mye du bærer.',
  'energy.sustainableTitle': 'Du kan spise nok',
  'energy.sustainableBody':
    'Forbruket ({tdee} kcal/dag) ligger under inntakstaket ({ceiling} kcal/dag). Underskuddet på {deficit} kcal/dag er et valg, ikke et krav.',
  'energy.plannedIntake': 'Planlagt inntak {value} kcal/dag',
  'energy.massTitle': 'Vektendring over turen',
  'energy.massResult': '{kg} kg over {days}',
  'energy.massNoChange': 'Ingen vektendring med disse tallene.',
  'energy.assumptions': 'Forutsetninger',
  'energy.foodDensity': 'Energitetthet i mat (kcal/g)',
  'energy.foodDensityHint':
    'Tørrmat er typisk 4,4 kcal/g. Endre hvis du bærer noe annet – matvekten under følger.',
  'energy.packMass': 'Sekkvekt (kg)',
  'energy.packMassHint': 'Basisvekt før mat. Maten kommer i tillegg per etappe.',
  'energy.foodMass': 'Mat for hele turen: {kg} kg',
  'energy.daysLabel': '{days} à {km}',
  'energy.rangeNote': 'Spennet er modellens usikkerhet (×0,75–×1,30), ikke en måling.',
  'energy.placeholderProfile':
    'Beregnet med standardprofil {mass} kg / {height} cm / {age} år — ikke dine egne tall.',
  'energy.setOwnNumbers': 'Sett dine egne tall',
  'energy.fatAssumed': 'Kroppsfett er antatt {percent} % fordi du ikke oppgav det.',
  'energy.chartAxis': 'kcal per dag',
  'energy.massAxis': 'Dager',
  'settings.carryAllHint':
    'Du bærer all mat fra start. Lange strekninger mellom butikker gir et bærevarsel i forsyningspanelet.',
  'settings.mailDropsHint':
    'Pakkepost: en pakke til Post i butikk må hentes innen 7 dager (sendes mellom ankomst −7 og −5 dager). Poste restante: 21 dager (sendes mellom ankomst −21 og −5). Appen planlegger aldri en sending den ikke kan vise at er hentbar.',
} as const;

export type MessageKey = keyof typeof no;
