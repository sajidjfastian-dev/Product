FROM node:24-alpine AS frontend
WORKDIR /src/SampleWeb/ClientApp
COPY SampleWeb/ClientApp/package.json SampleWeb/ClientApp/package-lock.json ./
RUN npm ci
COPY SampleWeb/ClientApp/ ./
RUN npm run build

FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src

COPY ["SampleApi/SampleApi.csproj", "SampleApi/"]
COPY ["SampleWeb/SampleWeb.csproj", "SampleWeb/"]
RUN dotnet restore "SampleApi/SampleApi.csproj" && dotnet restore "SampleWeb/SampleWeb.csproj"

COPY SampleApi/ SampleApi/
COPY SampleWeb/ SampleWeb/
RUN dotnet publish "SampleApi/SampleApi.csproj" -c Release -o /app/api /p:UseAppHost=false \
    && dotnet publish "SampleWeb/SampleWeb.csproj" -c Release -o /app/web /p:UseAppHost=false

FROM mcr.microsoft.com/dotnet/aspnet:10.0 AS api
WORKDIR /app
ENV ASPNETCORE_HTTP_PORTS=8080
EXPOSE 8080
COPY --from=build /app/api .
ENTRYPOINT ["dotnet", "SampleApi.dll"]

FROM mcr.microsoft.com/dotnet/aspnet:10.0 AS web
WORKDIR /app
ENV ASPNETCORE_HTTP_PORTS=8081
EXPOSE 8081
COPY --from=build /app/web .
COPY --from=frontend /src/SampleWeb/wwwroot/ ./wwwroot/
ENTRYPOINT ["dotnet", "SampleWeb.dll"]
