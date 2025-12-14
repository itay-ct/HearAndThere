# הוראות ליצירת קבצי PNG מהלוגו

הקוד מוכן להשתמש בקבצי PNG. צריך ליצור את הקבצים הבאים מתוך `icon-pin.svg`:

## קבצים נדרשים:

1. **icon-pin-180.png** - 180x180 פיקסלים (ל-iOS)
2. **icon-pin-152.png** - 152x152 פיקסלים (ל-iPad)
3. **icon-pin-120.png** - 120x120 פיקסלים (ל-iPhone ישן יותר)
4. **icon-pin-192.png** - 192x192 פיקסלים (ל-Android)
5. **icon-pin-512.png** - 512x512 פיקסלים (ל-Android, splash screen)

## איך ליצור את הקבצים:

### אפשרות 1: כלי מקוון (הכי פשוט)
1. פתח את https://cloudconvert.com/svg-to-png
2. העלה את `icon-pin.svg`
3. שנה את הגודל לגודל הרצוי (180x180, 192x192, וכו')
4. הורד והעבר לתיקייה `public/` עם השם המתאים

### אפשרות 2: ImageMagick (אם מותקן)
```bash
cd frontend/public
convert icon-pin.svg -resize 180x180 icon-pin-180.png
convert icon-pin.svg -resize 152x152 icon-pin-152.png
convert icon-pin.svg -resize 120x120 icon-pin-120.png
convert icon-pin.svg -resize 192x192 icon-pin-192.png
convert icon-pin.svg -resize 512x512 icon-pin-512.png
```

### אפשרות 3: Inkscape (אם מותקן)
```bash
cd frontend/public
inkscape icon-pin.svg --export-width=180 --export-filename=icon-pin-180.png
inkscape icon-pin.svg --export-width=152 --export-filename=icon-pin-152.png
inkscape icon-pin.svg --export-width=120 --export-filename=icon-pin-120.png
inkscape icon-pin.svg --export-width=192 --export-filename=icon-pin-192.png
inkscape icon-pin.svg --export-width=512 --export-filename=icon-pin-512.png
```

### אפשרות 4: Photoshop / GIMP / כל עורך תמונות
1. פתח את `icon-pin.svg`
2. שנה את הגודל לגודל הרצוי
3. שמור כ-PNG עם השם המתאים

## הערה:
אם לא תיצור את קבצי ה-PNG, הקוד ישתמש ב-SVG כ-fallback, אבל PNG מומלץ יותר לתמיכה טובה יותר בכל המכשירים.


