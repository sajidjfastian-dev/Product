FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src
COPY ["SampleApi/SampleApi.csproj", "SampleApi/"]
RUN dotnet restore "SampleApi/SampleApi.csproj"
COPY SampleApi/ SampleApi/
WORKDIR /src/SampleApi
RUN dotnet publish "SampleApi.csproj" -c Release -o /app/publish /p:UseAppHost=false

FROM mcr.microsoft.com/dotnet/aspnet:10.0 AS final
WORKDIR /app
ENV ASPNETCORE_HTTP_PORTS=8080
EXPOSE 8080
COPY --from=build /app/publish .
ENTRYPOINT ["dotnet", "SampleApi.dll"]
