declare global {
  interface Window {
    google: {
      maps: {
        Map: any
        Marker: any
        DirectionsService: any
        DirectionsRenderer: any
        TravelMode: {
          WALKING: string
        }
        MapTypeId: {
          ROADMAP: string
        }
        Size: any
      }
    }
  }
}

export {}