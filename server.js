require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors');

const app = express();
app.use(cors()); // Разрешаем кросс-доменные запросы
app.use(express.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

app.post('/submit-preferences', async (req, res) => {
    const { user_id, room_id, genres, years } = req.body;

    try {
        // Валидация входных данных
        if (!user_id || !room_id || !genres || !years || !Array.isArray(genres) || !Array.isArray(years) || genres.length === 0 || years.length !== 2) {
            console.error('Invalid request body:', { user_id, room_id, genres, years });
            return res.status(400).json({ error: 'Invalid request: genres and years must be non-empty arrays' });
        }

        // Валидация диапазона годов
        if (years[0] > years[1]) {
            console.error('Invalid year range:', years);
            return res.status(400).json({ error: 'Invalid year range: start year must be less than or equal to end year' });
        }

        console.log('Received preferences:', { user_id, room_id, genres, years });

        // Сохраняем предпочтения в user_preferences
        const { error: insertError } = await supabase
            .from('user_preferences')
            .insert({ user_id, room_id, genres, years });

        if (insertError) {
            console.error('Error inserting preferences:', insertError);
            return res.status(500).json({ error: 'Failed to save preferences' });
        }

        // Проверяем, все ли пользователи в комнате отправили предпочтения
        const { data: preferences, error: fetchError } = await supabase
            .from('user_preferences')
            .select('*')
            .eq('room_id', room_id);

        if (fetchError) {
            console.error('Error fetching preferences:', fetchError);
            return res.status(500).json({ error: 'Failed to fetch preferences' });
        }

        const { data: users, error: usersError } = await supabase
            .from('user_sessions')
            .select('user_id')
            .eq('room_id', room_id)
            .eq('is_online', true);

        if (usersError) {
            console.error('Error fetching users:', usersError);
            return res.status(500).json({ error: 'Failed to fetch users' });
        }

        // Если все пользователи отправили предпочтения
        if (preferences.length === users.length && preferences.length > 0) {
            // Объединяем жанры (уникальный список)
            const allGenres = [...new Set(preferences.flatMap(p => p.genres))];
            // Собираем все диапазоны годов
            const yearRanges = preferences.map(p => {
                if (p.years[0] > p.years[1]) {
                    console.error('Invalid year range in preferences:', p.years);
                    throw new Error('Invalid year range in preferences');
                }
                return { start: p.years[0], end: p.years[1] };
            });

            console.log('Aggregated preferences:', { genres: allGenres, yearRanges });

            // Объединяем пересекающиеся или примыкающие диапазоны
            const mergedRanges = [];
            yearRanges.sort((a, b) => a.start - b.start); // Сортируем по началу
            let current = { ...yearRanges[0] };
            for (let i = 1; i < yearRanges.length; i++) {
                const next = yearRanges[i];
                if (next.start <= current.end + 1) {
                    current.end = Math.max(current.end, next.end);
                } else {
                    mergedRanges.push(current);
                    current = { ...next };
                }
            }
            mergedRanges.push(current);
            console.log('Merged year ranges:', mergedRanges);

            // Формируем запрос к API Кинопоиска
            const params = new URLSearchParams();
            params.append('page', '1');
            params.append('limit', '100'); // Увеличиваем лимит для большего пула фильмов
            allGenres.forEach(genre => params.append('genres.name', genre)); // Все жанры без +
            ['id', 'name', 'year', 'movieLength', 'rating', 'description', 'genres', 'poster'].forEach(field => params.append('selectFields', field));
            ['name', 'description', 'poster.url'].forEach(field => params.append('notNullFields', field));
            params.append('sortField', 'rating.kp');
            params.append('sortType', '-1');
            ['movie', 'cartoon', 'anime'].forEach(type => params.append('type', type)); // Добавляем все типы

            // Обрабатываем диапазоны годов
            if (mergedRanges.length > 0) {
                // Выбираем самый широкий диапазон для year=начало-конец
                const widestRange = mergedRanges.reduce((widest, range) => {
                    const width = range.end - range.start;
                    const widestWidth = widest.end - widest.start;
                    return width > widestWidth ? range : widest;
                }, mergedRanges[0]);
                params.append('year', `${widestRange.start}-${widestRange.end}`);
                console.log('Selected widest range:', widestRange);

                // Для остальных диапазонов перечисляем отдельные годы (до 10 годов)
                let yearCount = 0;
                const maxYears = 15;
                mergedRanges
                    .filter(range => range !== widestRange)
                    .forEach(range => {
                        for (let year = range.end; year >= range.start && yearCount < maxYears; year--) {
                            params.append('year', year.toString());
                            yearCount++;
                        }
                    });
                console.log('Enumerated years:', params.getAll('year').slice(1));
            }

            console.log('Kinopoisk API URL:', `https://api.kinopoisk.dev/v1.4/movie?${params.toString()}`);

            try {
                const response = await axios.get(`https://api.kinopoisk.dev/v1.4/movie?${params.toString()}`, {
                    headers: { 'X-API-KEY': process.env.KINOPOISK_API_KEY }
                });

                const movies = response.data.docs;

                console.log('Fetched movies:', movies.length);
                console.log('Years in results:', [...new Set(movies.map(m => m.year))]);
                console.log('Types in results:', [...new Set(movies.map(m => m.type))]);

                // Сохраняем результаты в room_results
                const { error: resultError } = await supabase
                    .from('room_results')
                    .insert({ room_id, movies });

                if (resultError) {
                    console.error('Error saving results:', resultError);
                    return res.status(500).json({ error: 'Failed to save results' });
                }

                return res.status(200).json({ status: 'ready' });
            } catch (apiError) {
                console.error('Error fetching movies:', apiError);
                return res.status(500).json({ error: 'Failed to fetch movies' });
            }
        } else {
            return res.status(200).json({ status: 'waiting' });
        }
    } catch (error) {
        console.error('Unexpected error:', error);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/check-status', async (req, res) => {
    const { room_id } = req.query;

    if (!room_id) {
        return res.status(400).json({ error: 'room_id is required' });
    }

    try {
        // Проверяем, есть ли результаты для комнаты
        const { data: results, error: resultError } = await supabase
            .from('room_results')
            .select('room_id')
            .eq('room_id', room_id);

        if (resultError) {
            console.error('Error checking room results:', resultError);
            return res.status(500).json({ error: 'Failed to check status' });
        }

        if (results.length > 0) {
            return res.status(200).json({ status: 'ready' });
        }

        // Проверяем, есть ли предпочтения
        const { data: preferences, error: prefError } = await supabase
            .from('user_preferences')
            .select('room_id')
            .eq('room_id', room_id);

        if (prefError) {
            console.error('Error checking preferences:', prefError);
            return res.status(500).json({ error: 'Failed to check preferences' });
        }

        if (preferences.length > 0) {
            return res.status(200).json({ status: 'waiting' });
        }

        return res.status(404).json({ error: 'Room not found' });
    } catch (error) {
        console.error('Unexpected error:', error);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});