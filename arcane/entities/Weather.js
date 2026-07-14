function number(value,label,{minimum=-Infinity,maximum=Infinity}={}){const result=Number(value);if(!Number.isFinite(result)||result<minimum||result>maximum)throw new TypeError(`${label} is invalid.`);return result;}
function text(value,label){const result=String(value??'').trim();if(!result)throw new TypeError(`${label} is required.`);return result;}
function instant(value,label){const date=new Date(value);if(Number.isNaN(date.valueOf()))throw new TypeError(`${label} is invalid.`);return date.toISOString();}

export class WeatherLocation{
    constructor({id='',name,region='',country='',latitude,longitude,timezone='auto'}={}){this.id=String(id||`${latitude},${longitude}`);this.name=text(name,'Weather location name');this.region=String(region||'');this.country=String(country||'');this.latitude=number(latitude,'Latitude',{minimum:-90,maximum:90});this.longitude=number(longitude,'Longitude',{minimum:-180,maximum:180});this.timezone=String(timezone||'auto');Object.freeze(this);}
    toJSON(){return {...this};}
}

export class WeatherObservation{
    constructor({time,temperature,apparentTemperature=temperature,humidity=0,precipitation=0,weatherCode=0,windSpeed=0,isDay=true,temperatureUnit='°',windUnit=''}={}){this.time=instant(time,'Observation time');this.temperature=number(temperature,'Temperature');this.apparentTemperature=number(apparentTemperature,'Apparent temperature');this.humidity=number(humidity,'Humidity',{minimum:0,maximum:100});this.precipitation=number(precipitation,'Precipitation',{minimum:0});this.weatherCode=Math.max(0,Math.trunc(Number(weatherCode)||0));this.windSpeed=number(windSpeed,'Wind speed',{minimum:0});this.isDay=Boolean(isDay);this.temperatureUnit=String(temperatureUnit||'°');this.windUnit=String(windUnit||'');Object.freeze(this);}
    toJSON(){return {...this};}
}

export class WeatherDay{
    constructor({date,weatherCode=0,temperatureMax,temperatureMin,precipitationProbability=0,sunrise='',sunset='',temperatureUnit='°'}={}){this.date=instant(date,'Forecast date');this.weatherCode=Math.max(0,Math.trunc(Number(weatherCode)||0));this.temperatureMax=number(temperatureMax,'Maximum temperature');this.temperatureMin=number(temperatureMin,'Minimum temperature');this.precipitationProbability=number(precipitationProbability,'Precipitation probability',{minimum:0,maximum:100});this.sunrise=sunrise?instant(sunrise,'Sunrise'):'';this.sunset=sunset?instant(sunset,'Sunset'):'';this.temperatureUnit=String(temperatureUnit||'°');Object.freeze(this);}
    toJSON(){return {...this};}
}

export class WeatherSnapshot{
    constructor({location,current,daily=[],source='',fetchedAt=new Date()}={}){this.location=location instanceof WeatherLocation?location:new WeatherLocation(location);this.current=current instanceof WeatherObservation?current:new WeatherObservation(current);this.daily=Object.freeze(Array.from(daily,value=>value instanceof WeatherDay?value:new WeatherDay(value)));this.source=String(source||'');this.fetchedAt=instant(fetchedAt,'Weather fetch time');Object.freeze(this);}
    toJSON(){return {location:this.location.toJSON(),current:this.current.toJSON(),daily:this.daily.map(day=>day.toJSON()),source:this.source,fetchedAt:this.fetchedAt};}
}
