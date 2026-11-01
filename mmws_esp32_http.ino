/*
  MMWS — Node sensor & aktuator ESP32, versi HTTPS untuk server Cloudflare Workers
  Tesis: Kendali Prediktif IoT pada Mist Water System — Trafo 1 150/20 kV 60 MVA GIS Randugarut

  Cara kerja
   - Sampling DHT11 tiap 2,5 detik, DS18B20 & rata-rata tiap 10 detik.
   - Kirim data ke https://<domain>/api/ingest (POST JSON, header Authorization: Bearer DEVICE_TOKEN).
     Balasan server berisi perintah pompa {"mist":0/1} dan interval kirim berikutnya {"next_s":N}.
     Normal tiap 60 detik; 10 detik setelah perintah mist berubah; 5 detik saat mengirim data cadangan.
   - Server tidak membalas > 5 menit → kendali lokal cadangan (ambang suhu dinding tangki DS18B20).
   - Saat koneksi putus, rata-rata per menit disimpan (maks 24 jam) lalu dikirim ulang 30 menit per kiriman.
   - Float switch: air habis → pompa dipaksa mati, apa pun perintah server.

  Library (Arduino IDE > Library Manager):
   "DHT sensor library" (Adafruit) + "Adafruit Unified Sensor", "OneWire", "DallasTemperature"
   HTTPClient dan WiFiClientSecure sudah termasuk paket board esp32 (Espressif Systems).
  Board: "ESP32 Dev Module".
*/
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <DHT.h>
#include <time.h>

#define USE_DS18B20 1
#if USE_DS18B20
#include <OneWire.h>
#include <DallasTemperature.h>
#endif

// ======================= KONFIGURASI — SESUAIKAN =======================
const char* WIFI_SSID    = "NAMA_WIFI_ROUTER_4G";
const char* WIFI_PASS    = "PASSWORD_WIFI";
const char* INGEST_URL   = "https://mmws.tamabyte.com/api/ingest";   // domain website MMWS Anda
const char* DEVICE_TOKEN = "ISI_DEVICE_TOKEN";                         // sama dengan wrangler secret DEVICE_TOKEN
const char* NODE_ID      = "esp32-sensor";

#define DHT_TYPE        DHT11     // ganti DHT22 bila memakai DHT22
#define PIN_DHT_AMB     4         // DHT11 ambien (pull-up 10k ke 3V3 bila bukan modul)
#define PIN_DHT_IN      16        // DHT11 udara masuk radiator
#define PIN_ONEWIRE     17        // DS18B20 (pull-up 4k7 ke 3V3)
#define PIN_RELAY       26        // relay pompa / solenoid mist
#define RELAY_ACTIVE_LOW true     // modul relay umum aktif LOW
#define PIN_FLOAT       27        // float switch level air (opsional), -1 bila tidak dipakai
#define FLOAT_EMPTY_LEVEL LOW     // pembacaan saat air habis

// Koreksi kalibrasi terhadap termometer referensi (T_aktual = T_sensor + K)
const float CAL_AMB_T = 0.0, CAL_AMB_RH = 0.0;
const float CAL_IN_T  = 0.0, CAL_IN_RH  = 0.0;
const float CAL_DS[3] = {0.0, 0.0, 0.0};
const char* DS_NAMES[3] = {"tangki", "header_atas", "header_bawah"}; // urutan indeks bus (lihat Serial Monitor)

const unsigned long SAMPLE_MS = 10000;               // rata-rata sensor
const unsigned long CMD_TIMEOUT_MS = 5UL * 60000UL;  // kendali lokal bila server diam 5 menit
const float FALLBACK_ON = 70.0, FALLBACK_HYS = 2.0;  // ambang lokal suhu tangki (DS18B20)
const unsigned long MIN_SWITCH_MS = 60000;           // jeda minimum ganti status pompa
#define BUF_MAX 1440                                  // penyangga offline: 24 jam @ 1 menit
#define ROWS_PER_POST 30
// ======================================================================

// Root CA yang dipakai sertifikat Cloudflare (Google Trust Services, Let's Encrypt, SSL.com)
static const char ROOT_CA[] PROGMEM = R"PEM(
-----BEGIN CERTIFICATE-----
MIIFazCCA1OgAwIBAgIRAIIQz7DSQONZRGPgu2OCiwAwDQYJKoZIhvcNAQELBQAw
TzELMAkGA1UEBhMCVVMxKTAnBgNVBAoTIEludGVybmV0IFNlY3VyaXR5IFJlc2Vh
cmNoIEdyb3VwMRUwEwYDVQQDEwxJU1JHIFJvb3QgWDEwHhcNMTUwNjA0MTEwNDM4
WhcNMzUwNjA0MTEwNDM4WjBPMQswCQYDVQQGEwJVUzEpMCcGA1UEChMgSW50ZXJu
ZXQgU2VjdXJpdHkgUmVzZWFyY2ggR3JvdXAxFTATBgNVBAMTDElTUkcgUm9vdCBY
MTCCAiIwDQYJKoZIhvcNAQEBBQADggIPADCCAgoCggIBAK3oJHP0FDfzm54rVygc
h77ct984kIxuPOZXoHj3dcKi/vVqbvYATyjb3miGbESTtrFj/RQSa78f0uoxmyF+
0TM8ukj13Xnfs7j/EvEhmkvBioZxaUpmZmyPfjxwv60pIgbz5MDmgK7iS4+3mX6U
A5/TR5d8mUgjU+g4rk8Kb4Mu0UlXjIB0ttov0DiNewNwIRt18jA8+o+u3dpjq+sW
T8KOEUt+zwvo/7V3LvSye0rgTBIlDHCNAymg4VMk7BPZ7hm/ELNKjD+Jo2FR3qyH
B5T0Y3HsLuJvW5iB4YlcNHlsdu87kGJ55tukmi8mxdAQ4Q7e2RCOFvu396j3x+UC
B5iPNgiV5+I3lg02dZ77DnKxHZu8A/lJBdiB3QW0KtZB6awBdpUKD9jf1b0SHzUv
KBds0pjBqAlkd25HN7rOrFleaJ1/ctaJxQZBKT5ZPt0m9STJEadao0xAH0ahmbWn
OlFuhjuefXKnEgV4We0+UXgVCwOPjdAvBbI+e0ocS3MFEvzG6uBQE3xDk3SzynTn
jh8BCNAw1FtxNrQHusEwMFxIt4I7mKZ9YIqioymCzLq9gwQbooMDQaHWBfEbwrbw
qHyGO0aoSCqI3Haadr8faqU9GY/rOPNk3sgrDQoo//fb4hVC1CLQJ13hef4Y53CI
rU7m2Ys6xt0nUW7/vGT1M0NPAgMBAAGjQjBAMA4GA1UdDwEB/wQEAwIBBjAPBgNV
HRMBAf8EBTADAQH/MB0GA1UdDgQWBBR5tFnme7bl5AFzgAiIyBpY9umbbjANBgkq
hkiG9w0BAQsFAAOCAgEAVR9YqbyyqFDQDLHYGmkgJykIrGF1XIpu+ILlaS/V9lZL
ubhzEFnTIZd+50xx+7LSYK05qAvqFyFWhfFQDlnrzuBZ6brJFe+GnY+EgPbk6ZGQ
3BebYhtF8GaV0nxvwuo77x/Py9auJ/GpsMiu/X1+mvoiBOv/2X/qkSsisRcOj/KK
NFtY2PwByVS5uCbMiogziUwthDyC3+6WVwW6LLv3xLfHTjuCvjHIInNzktHCgKQ5
ORAzI4JMPJ+GslWYHb4phowim57iaztXOoJwTdwJx4nLCgdNbOhdjsnvzqvHu7Ur
TkXWStAmzOVyyghqpZXjFaH3pO3JLF+l+/+sKAIuvtd7u+Nxe5AW0wdeRlN8NwdC
jNPElpzVmbUq4JUagEiuTDkHzsxHpFKVK7q4+63SM1N95R1NbdWhscdCb+ZAJzVc
oyi3B43njTOQ5yOf+1CceWxG1bQVs5ZufpsMljq4Ui0/1lvh+wjChP4kqKOJ2qxq
4RgqsahDYVvTH9w7jXbyLeiNdd8XM2w9U/t7y0Ff/9yi0GE44Za4rF2LN9d11TPA
mRGunUHBcnWEvgJBQl9nJEiU0Zsnvgc/ubhPgXRR4Xq37Z0j4r7g1SgEEzwxA57d
emyPxgcYxn/eR44/KJ4EBs+lVDR3veyJm+kXQ99b21/+jh5Xos1AnX5iItreGCc=
-----END CERTIFICATE-----
-----BEGIN CERTIFICATE-----
MIICGzCCAaGgAwIBAgIQQdKd0XLq7qeAwSxs6S+HUjAKBggqhkjOPQQDAzBPMQsw
CQYDVQQGEwJVUzEpMCcGA1UEChMgSW50ZXJuZXQgU2VjdXJpdHkgUmVzZWFyY2gg
R3JvdXAxFTATBgNVBAMTDElTUkcgUm9vdCBYMjAeFw0yMDA5MDQwMDAwMDBaFw00
MDA5MTcxNjAwMDBaME8xCzAJBgNVBAYTAlVTMSkwJwYDVQQKEyBJbnRlcm5ldCBT
ZWN1cml0eSBSZXNlYXJjaCBHcm91cDEVMBMGA1UEAxMMSVNSRyBSb290IFgyMHYw
EAYHKoZIzj0CAQYFK4EEACIDYgAEzZvVn4CDCuwJSvMWSj5cz3es3mcFDR0HttwW
+1qLFNvicWDEukWVEYmO6gbf9yoWHKS5xcUy4APgHoIYOIvXRdgKam7mAHf7AlF9
ItgKbppbd9/w+kHsOdx1ymgHDB/qo0IwQDAOBgNVHQ8BAf8EBAMCAQYwDwYDVR0T
AQH/BAUwAwEB/zAdBgNVHQ4EFgQUfEKWrt5LSDv6kviejM9ti6lyN5UwCgYIKoZI
zj0EAwMDaAAwZQIwe3lORlCEwkSHRhtFcP9Ymd70/aTSVaYgLXTWNLxBo1BfASdW
tL4ndQavEi51mI38AjEAi/V3bNTIZargCyzuFJ0nN6T5U6VR5CmD1/iQMVtCnwr1
/q4AaOeMSQ+2b1tbFfLn
-----END CERTIFICATE-----
-----BEGIN CERTIFICATE-----
MIIFVzCCAz+gAwIBAgINAgPlk28xsBNJiGuiFzANBgkqhkiG9w0BAQwFADBHMQsw
CQYDVQQGEwJVUzEiMCAGA1UEChMZR29vZ2xlIFRydXN0IFNlcnZpY2VzIExMQzEU
MBIGA1UEAxMLR1RTIFJvb3QgUjEwHhcNMTYwNjIyMDAwMDAwWhcNMzYwNjIyMDAw
MDAwWjBHMQswCQYDVQQGEwJVUzEiMCAGA1UEChMZR29vZ2xlIFRydXN0IFNlcnZp
Y2VzIExMQzEUMBIGA1UEAxMLR1RTIFJvb3QgUjEwggIiMA0GCSqGSIb3DQEBAQUA
A4ICDwAwggIKAoICAQC2EQKLHuOhd5s73L+UPreVp0A8of2C+X0yBoJx9vaMf/vo
27xqLpeXo4xL+Sv2sfnOhB2x+cWX3u+58qPpvBKJXqeqUqv4IyfLpLGcY9vXmX7w
Cl7raKb0xlpHDU0QM+NOsROjyBhsS+z8CZDfnWQpJSMHobTSPS5g4M/SCYe7zUjw
TcLCeoiKu7rPWRnWr4+wB7CeMfGCwcDfLqZtbBkOtdh+JhpFAz2weaSUKK0Pfybl
qAj+lug8aJRT7oM6iCsVlgmy4HqMLnXWnOunVmSPlk9orj2XwoSPwLxAwAtcvfaH
szVsrBhQf4TgTM2S0yDpM7xSma8ytSmzJSq0SPly4cpk9+aCEI3oncKKiPo4Zor8
Y/kB+Xj9e1x3+naH+uzfsQ55lVe0vSbv1gHR6xYKu44LtcXFilWr06zqkUspzBmk
MiVOKvFlRNACzqrOSbTqn3yDsEB750Orp2yjj32JgfpMpf/VjsPOS+C12LOORc92
wO1AK/1TD7Cn1TsNsYqiA94xrcx36m97PtbfkSIS5r762DL8EGMUUXLeXdYWk70p
aDPvOmbsB4om3xPXV2V4J95eSRQAogB/mqghtqmxlbCluQ0WEdrHbEg8QOB+DVrN
VjzRlwW5y0vtOUucxD/SVRNuJLDWcfr0wbrM7Rv1/oFB2ACYPTrIrnqYNxgFlQID
AQABo0IwQDAOBgNVHQ8BAf8EBAMCAYYwDwYDVR0TAQH/BAUwAwEB/zAdBgNVHQ4E
FgQU5K8rJnEaK0gnhS9SZizv8IkTcT4wDQYJKoZIhvcNAQEMBQADggIBAJ+qQibb
C5u+/x6Wki4+omVKapi6Ist9wTrYggoGxval3sBOh2Z5ofmmWJyq+bXmYOfg6LEe
QkEzCzc9zolwFcq1JKjPa7XSQCGYzyI0zzvFIoTgxQ6KfF2I5DUkzps+GlQebtuy
h6f88/qBVRRiClmpIgUxPoLW7ttXNLwzldMXG+gnoot7TiYaelpkttGsN/H9oPM4
7HLwEXWdyzRSjeZ2axfG34arJ45JK3VmgRAhpuo+9K4l/3wV3s6MJT/KYnAK9y8J
ZgfIPxz88NtFMN9iiMG1D53Dn0reWVlHxYciNuaCp+0KueIHoI17eko8cdLiA6Ef
MgfdG+RCzgwARWGAtQsgWSl4vflVy2PFPEz0tv/bal8xa5meLMFrUKTX5hgUvYU/
Z6tGn6D/Qqc6f1zLXbBwHSs09dR2CQzreExZBfMzQsNhFRAbd03OIozUhfJFfbdT
6u9AWpQKXCBfTkBdYiJ23//OYb2MI3jSNwLgjt7RETeJ9r/tSQdirpLsQBqvFAnZ
0E6yove+7u7Y/9waLd64NnHi/Hm3lCXRSHNboTXns5lndcEZOitHTtNCjv0xyBZm
2tIMPNuzjsmhDYAPexZ3FL//2wmUspO8IFgV6dtxQ/PeEMMA3KgqlbbC1j+Qa3bb
bP6MvPJwNQzcmRk13NfIRmPVNnGuV/u3gm3c
-----END CERTIFICATE-----
-----BEGIN CERTIFICATE-----
MIICCTCCAY6gAwIBAgINAgPluILrIPglJ209ZjAKBggqhkjOPQQDAzBHMQswCQYD
VQQGEwJVUzEiMCAGA1UEChMZR29vZ2xlIFRydXN0IFNlcnZpY2VzIExMQzEUMBIG
A1UEAxMLR1RTIFJvb3QgUjMwHhcNMTYwNjIyMDAwMDAwWhcNMzYwNjIyMDAwMDAw
WjBHMQswCQYDVQQGEwJVUzEiMCAGA1UEChMZR29vZ2xlIFRydXN0IFNlcnZpY2Vz
IExMQzEUMBIGA1UEAxMLR1RTIFJvb3QgUjMwdjAQBgcqhkjOPQIBBgUrgQQAIgNi
AAQfTzOHMymKoYTey8chWEGJ6ladK0uFxh1MJ7x/JlFyb+Kf1qPKzEUURout736G
jOyxfi//qXGdGIRFBEFVbivqJn+7kAHjSxm65FSWRQmx1WyRRK2EE46ajA2ADDL2
4CejQjBAMA4GA1UdDwEB/wQEAwIBhjAPBgNVHRMBAf8EBTADAQH/MB0GA1UdDgQW
BBTB8Sa6oC2uhYHP0/EqEr24Cmf9vDAKBggqhkjOPQQDAwNpADBmAjEA9uEglRR7
VKOQFhG/hMjqb2sXnh5GmCCbn9MN2azTL818+FsuVbu/3ZL3pAzcMeGiAjEA/Jdm
ZuVDFhOD3cffL74UOO0BzrEXGhF16b0DjyZ+hOXJYKaV11RZt+cRLInUue4X
-----END CERTIFICATE-----
-----BEGIN CERTIFICATE-----
MIICCTCCAY6gAwIBAgINAgPlwGjvYxqccpBQUjAKBggqhkjOPQQDAzBHMQswCQYD
VQQGEwJVUzEiMCAGA1UEChMZR29vZ2xlIFRydXN0IFNlcnZpY2VzIExMQzEUMBIG
A1UEAxMLR1RTIFJvb3QgUjQwHhcNMTYwNjIyMDAwMDAwWhcNMzYwNjIyMDAwMDAw
WjBHMQswCQYDVQQGEwJVUzEiMCAGA1UEChMZR29vZ2xlIFRydXN0IFNlcnZpY2Vz
IExMQzEUMBIGA1UEAxMLR1RTIFJvb3QgUjQwdjAQBgcqhkjOPQIBBgUrgQQAIgNi
AATzdHOnaItgrkO4NcWBMHtLSZ37wWHO5t5GvWvVYRg1rkDdc/eJkTBa6zzuhXyi
QHY7qca4R9gq55KRanPpsXI5nymfopjTX15YhmUPoYRlBtHci8nHc8iMai/lxKvR
HYqjQjBAMA4GA1UdDwEB/wQEAwIBhjAPBgNVHRMBAf8EBTADAQH/MB0GA1UdDgQW
BBSATNbrdP9JNqPV2Py1PsVq8JQdjDAKBggqhkjOPQQDAwNpADBmAjEA6ED/g94D
9J+uHXqnLrmvT/aDHQ4thQEd0dlq7A/Cr8deVl5c1RxYIigL9zC2L7F8AjEA8GE8
p/SgguMh1YQdc4acLa/KNJvxn7kjNuK8YAOdgLOaVsjh4rsUecrNIdSUtUlD
-----END CERTIFICATE-----
-----BEGIN CERTIFICATE-----
MIIB3DCCAYOgAwIBAgINAgPlfvU/k/2lCSGypjAKBggqhkjOPQQDAjBQMSQwIgYD
VQQLExtHbG9iYWxTaWduIEVDQyBSb290IENBIC0gUjQxEzARBgNVBAoTCkdsb2Jh
bFNpZ24xEzARBgNVBAMTCkdsb2JhbFNpZ24wHhcNMTIxMTEzMDAwMDAwWhcNMzgw
MTE5MDMxNDA3WjBQMSQwIgYDVQQLExtHbG9iYWxTaWduIEVDQyBSb290IENBIC0g
UjQxEzARBgNVBAoTCkdsb2JhbFNpZ24xEzARBgNVBAMTCkdsb2JhbFNpZ24wWTAT
BgcqhkjOPQIBBggqhkjOPQMBBwNCAAS4xnnTj2wlDp8uORkcA6SumuU5BwkWymOx
uYb4ilfBV85C+nOh92VC/x7BALJucw7/xyHlGKSq2XE/qNS5zowdo0IwQDAOBgNV
HQ8BAf8EBAMCAYYwDwYDVR0TAQH/BAUwAwEB/zAdBgNVHQ4EFgQUVLB7rUW44kB/
+wpu+74zyTyjhNUwCgYIKoZIzj0EAwIDRwAwRAIgIk90crlgr/HmnKAWBVBfw147
bmF0774BxL4YSFlhgjICICadVGNA3jdgUM/I2O2dgq43mLyjj0xMqTQrbO/7lZsm
-----END CERTIFICATE-----
-----BEGIN CERTIFICATE-----
MIICjTCCAhSgAwIBAgIIdebfy8FoW6gwCgYIKoZIzj0EAwIwfDELMAkGA1UEBhMC
VVMxDjAMBgNVBAgMBVRleGFzMRAwDgYDVQQHDAdIb3VzdG9uMRgwFgYDVQQKDA9T
U0wgQ29ycG9yYXRpb24xMTAvBgNVBAMMKFNTTC5jb20gUm9vdCBDZXJ0aWZpY2F0
aW9uIEF1dGhvcml0eSBFQ0MwHhcNMTYwMjEyMTgxNDAzWhcNNDEwMjEyMTgxNDAz
WjB8MQswCQYDVQQGEwJVUzEOMAwGA1UECAwFVGV4YXMxEDAOBgNVBAcMB0hvdXN0
b24xGDAWBgNVBAoMD1NTTCBDb3Jwb3JhdGlvbjExMC8GA1UEAwwoU1NMLmNvbSBS
b290IENlcnRpZmljYXRpb24gQXV0aG9yaXR5IEVDQzB2MBAGByqGSM49AgEGBSuB
BAAiA2IABEVuqVDEpiM2nl8ojRfLliJkP9x6jh3MCLOicSS6jkm5BBtHllirLZXI
7Z4INcgn64mMU1jrYor+8FsPazFSY0E7ic3s7LaNGdM0B9y7xgZ/wkWV7Mt/qCPg
CemB+vNH06NjMGEwHQYDVR0OBBYEFILRhXMw5zUE044CkvvlpNHEIejNMA8GA1Ud
EwEB/wQFMAMBAf8wHwYDVR0jBBgwFoAUgtGFczDnNQTTjgKS++Wk0cQh6M0wDgYD
VR0PAQH/BAQDAgGGMAoGCCqGSM49BAMCA2cAMGQCMG/n61kRpGDPYbCWe+0F+S8T
kdzt5fxQaxFGRrMcIQBiu77D5+jNB5n5DQtdcj7EqgIwH7y6C+IwJPt8bYBVCpk+
gA0z5Wajs6O7pdWLjwkspl1+4vAHCGht0nxpbl/f5Wpl
-----END CERTIFICATE-----
-----BEGIN CERTIFICATE-----
MIIF3TCCA8WgAwIBAgIIeyyb0xaAMpkwDQYJKoZIhvcNAQELBQAwfDELMAkGA1UE
BhMCVVMxDjAMBgNVBAgMBVRleGFzMRAwDgYDVQQHDAdIb3VzdG9uMRgwFgYDVQQK
DA9TU0wgQ29ycG9yYXRpb24xMTAvBgNVBAMMKFNTTC5jb20gUm9vdCBDZXJ0aWZp
Y2F0aW9uIEF1dGhvcml0eSBSU0EwHhcNMTYwMjEyMTczOTM5WhcNNDEwMjEyMTcz
OTM5WjB8MQswCQYDVQQGEwJVUzEOMAwGA1UECAwFVGV4YXMxEDAOBgNVBAcMB0hv
dXN0b24xGDAWBgNVBAoMD1NTTCBDb3Jwb3JhdGlvbjExMC8GA1UEAwwoU1NMLmNv
bSBSb290IENlcnRpZmljYXRpb24gQXV0aG9yaXR5IFJTQTCCAiIwDQYJKoZIhvcN
AQEBBQADggIPADCCAgoCggIBAPkP3aMrfcvQKv7sZ4Wm5y4bunfh4/WvpOz6Sl2R
xFdHaxh3a3by/ZPkPQ/CFp4LZsNWlJ4Xg4XOVu/yFv0AYvUiCVToZRdOQbngT0aX
qhvIuG5iXmmxX9sqAn78bMrzQdjt0Oj8P2FI7bADFB0QDksZ4LtO7IZl/zbzXmcC
C52GVWH9ejjt/uIZALdvoVBidXQ8oPrIJZK0bnoix/geoeOy3ZExqysdBP+lSgQ3
6YWkMyv94tZVNHwZpEpox7Ko07fKoZOI68GXvIz5HdkihCR0xwQ9aqkpk8zruFvh
/l8lqjRYyMEjVJ0bmBHDOJx+PYZspQ9AhnwC9FwCTyjLrnGfDzrIM/4RJTXq/LrF
YD3ZfBjVsqnTdXgDciLKOsMf7yzlLqn6niy2UUb9rwPW6mBo6oUWNmuF6R7As93E
JNyAKoFBbZQ+yODJgUEAnl6/f8UImKIYLEJAs/lvOCdLToD0PYFH4Ih86hzOtXVc
US4cK38acijnALXRdMbX5J+tB5O2UzU1/Dfkw/ZdFr4hc96SCvigY2q8lpJqPvi8
ZVWb3vUNiSYE/CUapiVpy8JtynziWV+XrOvvLsi81xtZPCvM8hnIk2snYxnP/Okm
+Mpxm3+T/jRnhE6Z6/yzeAkzcLpmpnbtG3PrGqUNxCITIJRWCk4sbE6x/c+cCbqi
M+2HAgMBAAGjYzBhMB0GA1UdDgQWBBTdBAkHovV6fVJTEpKV7jiAJQ2mWTAPBgNV
HRMBAf8EBTADAQH/MB8GA1UdIwQYMBaAFN0ECQei9Xp9UlMSkpXuOIAlDaZZMA4G
A1UdDwEB/wQEAwIBhjANBgkqhkiG9w0BAQsFAAOCAgEAIBgRlCn7Jp0cHh5wYfGV
cpNxJK1ok1iOMq8bs3AD/CUrdIWQPXhq9LmLpZc7tRiRux6n+UBbkflVma8eEdBc
Hadm47GUBwwyOabqG7B52B2ccETjit3E+ZUfijhDPwGFpUenPUayvOUiaPd7nNgs
PgohyC0zrL/FgZkxdMF1ccW+sfAjRfSda/wZY52jvATGGAslu1OJD7OAUN5F7kR/
q5R4ZJjT9ijdh9hwZXT7DrkT66cPYakylszeu+1jTBi7qUD3oFRuIIhxdRjqerQ0
cuAjJ3dctpDqhiVAq+8zD8ufgr6iIPv2tS0a5sKFsXQP+8hlAqRSAUfdSSLBv9jr
a6x+3uxjMxW3IwiPxg+NQVrdjsW5j+VFP3jbutIbQLH+cU0/4IGiul607BXgk90I
H37hVZkLId6Tngr75qNJvTYw/ud3sqB1l7UtgYgXZSD32pAAn8lSzDLKNXz1PQ/Y
K9f1JmzJBjSWFupwWRoyeXkLtoh/D1JIPb9s2KJELtFOt3JY04kTlf5Eq/jXixtu
nLwsoFvVagCvXzfh1foQC5ichucmj87w7G6KVwuA406ywKBjYZC6VWg3dGq2ktuf
oYYitmUnDuy2n0Jg5GfCtdpBC8TTi2EbvPofkSvXRAdeuims2cXp71NIWuuA8ShY
Ic2wBlX7Jz9TkHCpBB5XJ7k=
-----END CERTIFICATE-----
)PEM";

WiFiClientSecure net;
DHT dhtAmb(PIN_DHT_AMB, DHT_TYPE);
DHT dhtIn(PIN_DHT_IN, DHT_TYPE);
#if USE_DS18B20
OneWire oneWire(PIN_ONEWIRE);
DallasTemperature ds(&oneWire);
int dsCount = 0;
#endif

struct Acc { float t = 0, rh = 0; int n = 0; };
struct Rec { uint32_t ts; float at, arh, it, irh, tank; };
Acc accAmb, accIn;
Rec buf[BUF_MAX]; int bufHead = 0, bufCount = 0;
float minAt = 0, minArh = 0, minIt = 0, minIrh = 0, minTank = 0; int minN = 0, minTankN = 0;
float dsLast[3] = {NAN, NAN, NAN};
float lastAmbT = NAN, lastAmbRh = NAN, lastInT = NAN, lastInRh = NAN;
bool relayOn = false, serverWant = false;
unsigned long lastCmdMs = 0, lastSwitchMs = 0, lastSampleMs = 0, lastReadMs = 0, lastMinuteMs = 0, lastSendMs = 0, lastOkMs = 0;
unsigned long nextSendMs = 5000;
int failCount = 0;
String modeNow = "start";
static char body[3200];

bool timeValid() { return time(nullptr) > 1700000000; }
bool waterEmpty() { return (PIN_FLOAT >= 0) && digitalRead(PIN_FLOAT) == FLOAT_EMPTY_LEVEL; }
bool serverOnline() { return lastOkMs != 0 && millis() - lastOkMs < 120000UL; }

void setRelay(bool on) {
  if (on == relayOn) return;
  if (millis() - lastSwitchMs < MIN_SWITCH_MS && lastSwitchMs != 0) return;  // lindungi pompa
  relayOn = on; lastSwitchMs = millis();
  digitalWrite(PIN_RELAY, (on ^ RELAY_ACTIVE_LOW) ? HIGH : LOW);
  Serial.printf("[MIST] %s (%s)\n", on ? "ON" : "OFF", modeNow.c_str());
  nextSendMs = 3000;   // laporkan status pompa segera
}

void connectWiFi() {
  if (WiFi.status() == WL_CONNECTED) return;
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.print("[WiFi] menyambung");
  unsigned long t0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t0 < 15000) { delay(300); Serial.print("."); }
  if (WiFi.status() == WL_CONNECTED) {
    Serial.print(" OK "); Serial.println(WiFi.localIP().toString());
    configTime(0, 0, "pool.ntp.org", "time.google.com");   // jam untuk TLS & cap waktu data cadangan
  } else Serial.println(" gagal, coba lagi nanti");
}

void readDht() {
  float t = dhtAmb.readTemperature(), h = dhtAmb.readHumidity();
  if (!isnan(t) && !isnan(h)) { accAmb.t += t + CAL_AMB_T; accAmb.rh += h + CAL_AMB_RH; accAmb.n++; }
  t = dhtIn.readTemperature(); h = dhtIn.readHumidity();
  if (!isnan(t) && !isnan(h)) { accIn.t += t + CAL_IN_T; accIn.rh += h + CAL_IN_RH; accIn.n++; }
}

void finishAcc(Acc& a, float& outT, float& outRh) {
  if (a.n > 0) { outT = a.t / a.n; outRh = constrain(a.rh / a.n, 0, 100); } else { outT = NAN; outRh = NAN; }
  a = Acc();
}

void sampleAll() {
  finishAcc(accAmb, lastAmbT, lastAmbRh);
  finishAcc(accIn, lastInT, lastInRh);
#if USE_DS18B20
  if (dsCount > 0) {
    ds.requestTemperatures();
    for (int i = 0; i < dsCount && i < 3; i++) {
      float t = ds.getTempCByIndex(i);
      dsLast[i] = (t == DEVICE_DISCONNECTED_C || t < -50) ? NAN : t + CAL_DS[i];
    }
  }
#endif
  if (!isnan(lastAmbT) && !isnan(lastInT)) { minAt += lastAmbT; minArh += lastAmbRh; minIt += lastInT; minIrh += lastInRh; minN++; }
  if (!isnan(dsLast[0])) { minTank += dsLast[0]; minTankN++; }
}

void minuteTick() {
  if (!serverOnline() && timeValid() && minN > 0) {
    Rec r; r.ts = (uint32_t)time(nullptr);
    r.at = minAt / minN; r.arh = minArh / minN; r.it = minIt / minN; r.irh = minIrh / minN;
    r.tank = minTankN ? minTank / minTankN : NAN;
    buf[(bufHead + bufCount) % BUF_MAX] = r;
    if (bufCount < BUF_MAX) bufCount++; else bufHead = (bufHead + 1) % BUF_MAX;  // penuh: data tertua ditimpa
  }
  minAt = minArh = minIt = minIrh = minTank = 0; minN = minTankN = 0;
}

int addSensor(int pos, const char* name, float t, float rh, bool withRh) {
  if (isnan(t)) return pos + snprintf(body + pos, sizeof(body) - pos, ",\"%s\":{\"err\":1}", name);
  if (withRh) return pos + snprintf(body + pos, sizeof(body) - pos, ",\"%s\":{\"t\":%.1f,\"rh\":%.0f}", name, t, rh);
  return pos + snprintf(body + pos, sizeof(body) - pos, ",\"%s\":{\"t\":%.1f}", name, t);
}

long jsonInt(const String& s, const char* key, long def) {
  String k = String("\"") + key + "\":"; int i = s.indexOf(k);
  if (i < 0) return def;
  return s.substring(i + k.length()).toInt();
}

void sendData() {
  if (WiFi.status() != WL_CONNECTED) return;
  if (!timeValid()) { Serial.println("[HTTP] menunggu jam NTP untuk HTTPS..."); nextSendMs = 5000; return; }
  int pos = snprintf(body, sizeof(body), "{\"node\":\"%s\",\"relay\":%d,\"mode\":\"%s\",\"rssi\":%d,\"ip\":\"%s\",\"buf\":%d",
                     NODE_ID, relayOn ? 1 : 0, modeNow.c_str(), WiFi.RSSI(), WiFi.localIP().toString().c_str(), bufCount);
  if (PIN_FLOAT >= 0) pos += snprintf(body + pos, sizeof(body) - pos, ",\"float\":%d", waterEmpty() ? 0 : 1);
  pos = addSensor(pos, "ambien", lastAmbT, lastAmbRh, true);
  pos = addSensor(pos, "udara_in", lastInT, lastInRh, true);
#if USE_DS18B20
  for (int i = 0; i < dsCount && i < 3; i++) pos = addSensor(pos, DS_NAMES[i], dsLast[i], 0, false);
#endif
  int n = bufCount < ROWS_PER_POST ? bufCount : ROWS_PER_POST;
  if (n > 0) {
    pos += snprintf(body + pos, sizeof(body) - pos, ",\"rows\":[");
    for (int k = 0; k < n; k++) {
      Rec& r = buf[(bufHead + k) % BUF_MAX];
      char tank[16]; if (isnan(r.tank)) snprintf(tank, sizeof(tank), "null"); else snprintf(tank, sizeof(tank), "%.1f", r.tank);
      pos += snprintf(body + pos, sizeof(body) - pos, "%s[%lu,%.1f,%.0f,%.1f,%.0f,%s]", k ? "," : "", (unsigned long)r.ts, r.at, r.arh, r.it, r.irh, tank);
    }
    pos += snprintf(body + pos, sizeof(body) - pos, "]");
  }
  snprintf(body + pos, sizeof(body) - pos, "}");

  HTTPClient http;
  http.setTimeout(15000);
  if (!http.begin(net, INGEST_URL)) { Serial.println("[HTTP] URL salah"); nextSendMs = 30000; return; }
  http.addHeader("Content-Type", "application/json");
  http.addHeader("Authorization", String("Bearer ") + DEVICE_TOKEN);
  int code = http.POST((uint8_t*)body, strlen(body));
  if (code == 200) {
    String res = http.getString();
    lastOkMs = millis(); lastCmdMs = millis(); failCount = 0;
    serverWant = jsonInt(res, "mist", 0) == 1;
    long ack = jsonInt(res, "ack_rows", 0);
    if (ack > 0 && ack <= bufCount) { bufHead = (bufHead + ack) % BUF_MAX; bufCount -= ack; if (bufCount == 0) Serial.println("[BUF] semua data cadangan terkirim"); }
    long ns = jsonInt(res, "next_s", 60); if (ns < 5) ns = 5; if (ns > 300) ns = 300;
    nextSendMs = (unsigned long)ns * 1000UL;
    Serial.printf("[HTTP] OK, mist=%d, kirim lagi %ld s, cadangan %d menit\n", serverWant ? 1 : 0, ns, bufCount);
  } else {
    failCount++;
    nextSendMs = failCount < 3 ? 15000 : 60000;
    if (code == 401) Serial.println("[HTTP] 401: DEVICE_TOKEN tidak cocok dengan server");
    else if (code == 503) Serial.println("[HTTP] 503: DEVICE_TOKEN belum diatur di server");
    else Serial.printf("[HTTP] gagal kode %d (%s)\n", code, http.errorToString(code).c_str());
  }
  http.end();
}

void controlLoop() {
  bool serverAlive = lastCmdMs != 0 && millis() - lastCmdMs < CMD_TIMEOUT_MS;
  if (waterEmpty()) { modeNow = "air_habis"; setRelay(false); return; }
  if (serverAlive) { modeNow = "edge"; setRelay(serverWant); return; }
  modeNow = "lokal";                      // kendali lokal cadangan: ambang suhu tangki
  float tank = dsLast[0];
  if (isnan(tank)) { setRelay(false); return; }
  if (!relayOn && tank > FALLBACK_ON) setRelay(true);
  else if (relayOn && tank < FALLBACK_ON - FALLBACK_HYS) setRelay(false);
}

void setup() {
  Serial.begin(115200);
  pinMode(PIN_RELAY, OUTPUT);
  digitalWrite(PIN_RELAY, RELAY_ACTIVE_LOW ? HIGH : LOW);  // pompa mati saat boot
  if (PIN_FLOAT >= 0) pinMode(PIN_FLOAT, INPUT_PULLUP);
  dhtAmb.begin(); dhtIn.begin();
#if USE_DS18B20
  ds.begin(); dsCount = ds.getDeviceCount();
  Serial.printf("[DS18B20] %d sensor terdeteksi\n", dsCount);
  for (int i = 0; i < dsCount; i++) {
    DeviceAddress a; if (ds.getAddress(a, i)) {
      Serial.printf("  indeks %d -> %s, alamat ", i, i < 3 ? DS_NAMES[i] : "(tidak dipakai)");
      for (int k = 0; k < 8; k++) Serial.printf("%02X", a[k]);
      Serial.println();
    }
  }
  ds.setWaitForConversion(true);
#endif
  net.setCACert(ROOT_CA);
  connectWiFi();
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) { static unsigned long lastWifi = 0; if (millis() - lastWifi > 20000) { lastWifi = millis(); connectWiFi(); } }
  if (millis() - lastReadMs >= 2500) { lastReadMs = millis(); readDht(); }        // DHT11 maks ~1 Hz
  if (millis() - lastSampleMs >= SAMPLE_MS) { lastSampleMs = millis(); sampleAll(); }
  if (millis() - lastMinuteMs >= 60000) { lastMinuteMs = millis(); minuteTick(); }
  if (millis() - lastSendMs >= nextSendMs) { lastSendMs = millis(); sendData(); }
  controlLoop();
}
