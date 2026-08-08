#!/usr/bin/env python3
"""
Inserta la configuración de firma en el build.gradle que genera `cap add android`.

Ese archivo se crea en cada compilación, así que no se puede versionar con la
firma ya puesta. Las contraseñas llegan por variables de entorno desde los
secrets de GitHub y nunca tocan el repo.
"""
import re
import sys

RUTA = "android/app/build.gradle"

BLOQUE_FIRMA = """
    signingConfigs {
        release {
            storeFile file(System.getenv("RUTA_LLAVE") ?: "llave.jks")
            storePassword System.getenv("CLAVE_ALMACEN")
            keyAlias System.getenv("ALIAS_LLAVE")
            keyPassword System.getenv("CLAVE_LLAVE")
        }
    }
"""

try:
    with open(RUTA, encoding="utf-8") as f:
        g = f.read()
except FileNotFoundError:
    sys.exit(f"No existe {RUTA}. ¿Corrió `cap add android` antes de este paso?")

if "signingConfigs" in g:
    print("La firma ya estaba configurada, no se toca.")
    sys.exit(0)

# El bloque va justo después de la apertura de android {
g, n = re.subn(r"(android\s*\{)", r"\1" + BLOQUE_FIRMA, g, count=1)
if n == 0:
    sys.exit("No se encontró el bloque android { } en build.gradle")

# Y la referencia dentro de buildTypes → release
g, n = re.subn(
    r"(buildTypes\s*\{\s*release\s*\{)",
    r"\1\n            signingConfig signingConfigs.release",
    g,
    count=1,
)
if n == 0:
    sys.exit("No se encontró buildTypes { release { } } en build.gradle")

with open(RUTA, "w", encoding="utf-8") as f:
    f.write(g)

print("Firma configurada en build.gradle")
