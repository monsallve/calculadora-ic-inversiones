# Bolsillos · Calculadora de Interés Compuesto

PWA (Progressive Web App) instalable en Android e iPhone.

## Características

- **Bolsillos / cajitas** independientes para cada inversión
- Nombre editable de cada bolsillo
- Capital, tasa anual (%) y plazo en meses totalmente editables
- Tipos de rendimiento:
  - Compuesto diario
  - Compuesto mensual
  - Compuesto anual
  - Interés simple (mensual / anual)
  - Único al final del plazo
- Totales en tiempo real: Invertido + Rendimientos + Total general
- Datos guardados en el dispositivo (localStorage)
- Tema claro / oscuro
- Funciona offline una vez instalada
- Diseño mobile-first, listo para pantalla de inicio

## Cómo instalarla

### Opción A – Desde un servidor (recomendado)

1. Sube la carpeta completa a cualquier hosting estático (GitHub Pages, Netlify, Vercel, Firebase, etc.)
2. Abre la URL en Chrome (Android) o Safari (iPhone)
3. **Android (Chrome)**: menú ⋮ → “Instalar aplicación” o “Añadir a pantalla de inicio”
4. **iPhone (Safari)**: botón Compartir → “Añadir a pantalla de inicio”

### Opción B – Probar localmente

```bash
# Desde la carpeta del proyecto
npx serve .
# o
python3 -m http.server 8080
```

Luego abre `http://localhost:8080` en el navegador del teléfono (misma red) o usa un túnel.

> Nota: para que la instalación PWA funcione, el sitio debe servirse por **HTTPS** (o localhost).

## Uso

- Toca **+ Nuevo Bolsillo** para agregar una inversión
- Edita nombre, capital, tasa y plazo en cualquier momento
- Cambia el tipo de capitalización según cómo te paguen el rendimiento
- Mantén pulsado un bolsillo para eliminarlo
- Los totales de arriba se actualizan automáticamente

## Estructura

```
calculadora-bolsillos/
├── index.html
├── manifest.json
├── sw.js
├── css/styles.css
├── js/app.js
├── icons/
│   ├── icon-192.png
│   └── icon-512.png
└── README.md
```
