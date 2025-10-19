# MQTT Dashboard

Instrukcja instalacji i uruchomienia.

1. Zainstaluj Node.js (>=14) i npm na serwerze Linux.

2. Skopiuj pliki projektu do katalogu, np:
   sudo mkdir -p /opt/mqtt-dashboard
   sudo chown $USER:$USER /opt/mqtt-dashboard
   cd /opt/mqtt-dashboard
   (tutaj umieść pliki: package.json, server.js, public/, config.json, ...)

3. Zainstaluj zależności:
   npm install

4. Dostosuj config.json:
   - broker: ws://10.10.0.4:9002 (już ustawione)
   - port: 3000
   - dataDir: folder do przechowywania danych (np. /var/lib/mqtt-dashboard) - upewnij się że użytkownik ma prawa zapisu
   - pushover.token / pushover.user -> wstaw swoje wartości lub zostaw te w config (przykład)
   - topics: lista początkowych subskrypcji

5. Uruchom aplikację ręcznie:
   npm start
   Otwórz w przeglądarce: http://<server-ip>:3000

6. Aby zainstalować jako service systemd:
   - skopiuj mqtt-dashboard.service do /etc/systemd/system/mqtt-dashboard.service
   - edytuj User i WorkingDirectory jeśli potrzeba
   - wykonaj:
     sudo systemctl daemon-reload
     sudo systemctl enable mqtt-dashboard
     sudo systemctl start mqtt-dashboard
     sudo journalctl -u mqtt-dashboard -f

Uwaga o bezpieczeństwie:
- Ten projekt nie ma uwierzytelniania. Jeśli używasz go na sieci publicznej — zadbaj o zabezpieczenia (reverse proxy z auth, dostęp tylko w sieci LAN itp).
- Pushover: token i user umieść w config.json albo mechanizm env jeśli chcesz.

Jak działa powiadomienie Pushover:
- Gdy przychodzi wiadomość na topic i stan (wyznaczony przez porównanie wartości z progiem) zmienia się względem poprzedniego stanu, wysyłane jest powiadomienie.
- Treść wiadomości: "<hostname> <device> <sensor> <stan> value=<value>" (gdzie device/sensor są składnikami topic rozdzielone przez '/').
- priority: 0 normal, 1 awaryjny, 2 krytyczny.

Dane historyczne:
- Odczyty zapisywane są do plików JSON w folderze dataDir (oddzielny plik na topic).
- Przechowujemy dane przez retainDays dni (domyślnie 7). Serwer cyklicznie czyści stare wpisy.

Możliwości rozszerzeń:
- autoryzacja, SSL, obsługa wielu brokerów, lepsza agregacja danych, baza timeseries (InfluxDB) itp.